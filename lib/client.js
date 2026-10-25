/**
 * dsh-kymemory — 客户端半边：记忆系统面板
 *
 * 挂载点：官方插槽 conversation.view（与「对话」「概览」「轨迹」并列，order 8）。
 * 数据：宿主半边的只读 API /dsh-kymemory/api/{overview,group,search}。
 *
 * 三条纪律：
 *  1. 只读——面板能看不能改，写入仍然只走 memory_save 等工具，避免 UI 路径写坏正式库。
 *  2. 全程 fail-open——任何一步失败都只让面板自己消失，绝不连累官方 UI。
 *  3. 不污染用量——浏览族时后端用 recordUsage:false，面板查看不计入「被用过」。
 *
 * 加载约定（照 dsh-mnemon 的正确写法）：顶层必须是直接调用
 * window.__ModuleLoader__.load({...})，不能包 IIFE——包了宿主就认不出来。
 * 也不能在 package.json 里声明 dsh.client.immediately，那会让 bundle 被
 * 执行两次并抛 duplicate factory registration。
 */
window.__ModuleLoader__.load({
  // 必须等于包名：宿主按包名查找已注册的 factory，不匹配就报
  // client-modules: could not load "<包名>"
  id: 'dsh-kymemory',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var h = React.createElement;

    var PKG = 'dsh-kymemory';
    var SLOT = 'conversation.view';
    var API = '/dsh-kymemory/api';
    var STYLE_ID = 'dsh-kymemory-panel-style';

    // ── 样式 ──────────────────────────────────────────────────────────────
    var CSS = [
      '.km-panel{display:flex;flex-direction:column;gap:12px;padding:16px 18px;height:100%;overflow:auto;font-size:13px;line-height:1.6;color:var(--dsh-fg,#e6e6e6);}',
      '.km-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}',
      '.km-title{font-size:15px;font-weight:600;}',
      '.km-muted{opacity:.55;}',
      '.km-cards{display:flex;gap:8px;flex-wrap:wrap;}',
      '.km-card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:7px 11px;min-width:96px;}',
      '.km-card b{display:block;font-size:14px;font-weight:600;}',
      '.km-card span{font-size:11px;opacity:.6;}',
      '.km-ok{color:#5ad07a;}.km-warn{color:#e0b44a;}.km-err{color:#e06c6c;}',
      '.km-search{width:100%;box-sizing:border-box;padding:8px 11px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.22);color:inherit;font-size:13px;outline:none;}',
      '.km-search:focus{border-color:rgba(120,170,255,.6);}',
      '.km-list{display:flex;flex-direction:column;}',
      '.km-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 6px;border-radius:6px;cursor:pointer;}',
      '.km-row:hover{background:rgba(255,255,255,.05);}',
      '.km-row.open{background:rgba(120,170,255,.10);}',
      '.km-slug{font-family:ui-monospace,Menlo,monospace;font-size:12px;}',
      '.km-scope{font-size:10px;opacity:.5;margin-left:6px;}',
      '.km-count{font-size:11px;opacity:.6;white-space:nowrap;}',
      '.km-body{padding:4px 6px 10px 16px;border-left:2px solid rgba(255,255,255,.10);margin:2px 0 6px 6px;}',
      '.km-item{padding:3px 0;font-size:12px;}',
      '.km-date{font-family:ui-monospace,Menlo,monospace;opacity:.5;margin-right:6px;}',
      '.km-hit{padding:5px 6px;border-radius:6px;font-size:12px;}',
      '.km-hit:hover{background:rgba(255,255,255,.04);}',
      '.km-file{font-family:ui-monospace,Menlo,monospace;font-size:10px;opacity:.5;}',
      '.km-empty{opacity:.5;padding:10px 4px;}',
      '.km-tag{font-size:10px;padding:1px 6px;border-radius:10px;background:rgba(120,170,255,.16);margin-left:6px;}',
      '.km-issues{margin:0;padding-left:18px;font-size:12px;opacity:.75;}',
      '.km-issues li{margin:2px 0;}',
    ].join('\n');

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var el = document.createElement('style');
      el.id = STYLE_ID;
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    // ── 小工具 ───────────────────────────────────────────────────────────
    function kb(bytes) {
      var n = Number(bytes) || 0;
      return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB';
    }
    function fmtDate(text) {
      var m = /^-\s*(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(text);
      return m ? { date: m[1].slice(5), body: m[2] } : { date: '', body: text };
    }
    // 这个宿主里相对路径的 fetch 会抛 "The string did not match the expected
    // pattern"，所以所有请求都用当前页面 origin 拼成绝对地址。
    function apiUrl(path) {
      try {
        return new URL(API + path, window.location.href).toString();
      } catch (e) {
        return API + path;
      }
    }
    function getJson(path) {
      return fetch(apiUrl(path), { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
        return r.json();
      });
    }

    // ── 主面板 ────────────────────────────────────────────────────────────
    function Panel() {
      var s0 = React.useState(null);
      var data = s0[0], setData = s0[1];
      var s1 = React.useState(null);
      var error = s1[0], setError = s1[1];
      var s2 = React.useState('');
      var query = s2[0], setQuery = s2[1];
      var s3 = React.useState(null);
      var hits = s3[0], setHits = s3[1];
      var s4 = React.useState(null);
      var openSlug = s4[0], setOpenSlug = s4[1];
      var s5 = React.useState(null);
      var detail = s5[0], setDetail = s5[1];
      var s6 = React.useState(0);
      var reloadAt = s6[0], setReloadAt = s6[1];

      // 概览
      React.useEffect(function () {
        var alive = true;
        getJson('/overview')
          .then(function (d) {
            if (!alive) return;
            if (d && d.ok === false) setError(d.error || '加载失败');
            else setData(d);
          })
          .catch(function (e) {
            if (!alive) return;
            var detail = String(e && e.message ? e.message : e);
            // 把失败的地址也带出来：宿主协议/路径不对时能直接看出差在哪
            setError(detail + ' ｜ 请求地址：' + apiUrl('/overview') + ' ｜ 页面：' + window.location.href);
          });
        return function () {
          alive = false;
        };
      }, [reloadAt]);

      // 搜索（300ms 防抖）
      React.useEffect(function () {
        var q = query.trim();
        if (!q) {
          setHits(null);
          return undefined;
        }
        var alive = true;
        var timer = setTimeout(function () {
          getJson('/search?q=' + encodeURIComponent(q))
            .then(function (d) {
              if (alive) setHits(d && d.ok !== false ? d : { total: 0, hits: [] });
            })
            .catch(function () {
              if (alive) setHits({ total: 0, hits: [] });
            });
        }, 300);
        return function () {
          alive = false;
          clearTimeout(timer);
        };
      }, [query]);

      // 展开某个族
      function toggle(slug) {
        if (openSlug === slug) {
          setOpenSlug(null);
          setDetail(null);
          return;
        }
        setOpenSlug(slug);
        setDetail(null);
        getJson('/group?slug=' + encodeURIComponent(slug))
          .then(function (d) {
            setDetail(d && d.ok !== false ? d : { ok: false, error: (d && d.error) || '读取失败' });
          })
          .catch(function (e) {
            setDetail({ ok: false, error: String(e) });
          });
      }

      if (error) {
        return h('div', { className: 'km-panel' }, h('div', { className: 'km-err' }, '记忆面板加载失败：' + error));
      }
      if (!data) {
        return h('div', { className: 'km-panel' }, h('div', { className: 'km-empty' }, '读取记忆…'));
      }

      var doctor = data.doctor || {};
      var counts = doctor.counts || {};
      var inboxCount = (data.inbox || []).length;
      var healthClass = counts.error > 0 ? 'km-err' : counts.warn > 0 ? 'km-warn' : 'km-ok';

      // 卡片
      var cards = h(
        'div',
        { className: 'km-cards' },
        h('div', { className: 'km-card' }, h('b', null, data.index.lines + ' 行'), h('span', null, '索引 ' + kb(data.index.bytes) + ' / ' + kb(data.limits.maxIndexBytes))),
        h('div', { className: 'km-card' }, h('b', null, data.route.groups + ' 族'), h('span', null, data.route.entries + ' 条记忆')),
        h('div', { className: 'km-card' }, h('b', null, inboxCount + ' 个'), h('span', null, 'inbox 待整理')),
        h('div', { className: 'km-card' }, h('b', { className: healthClass }, doctor.ok ? '正常' : '有问题'), h('span', null, (counts.error || 0) + ' 错误 / ' + (counts.warn || 0) + ' 警告')),
        h('div', { className: 'km-card' }, h('b', null, (data.usage && data.usage.used) + ' / ' + (data.usage && data.usage.total)), h('span', null, '族被 recall 过')),
      );

      // 搜索结果
      var searchBlock = null;
      if (query.trim()) {
        if (!hits) {
          searchBlock = h('div', { className: 'km-empty' }, '搜索中…');
        } else if (!hits.total) {
          searchBlock = h('div', { className: 'km-empty' }, '没有匹配「' + query.trim() + '」的记忆');
        } else {
          searchBlock = h(
            'div',
            null,
            h('div', { className: 'km-muted', style: { marginBottom: '4px' } }, '命中 ' + hits.total + ' 条'),
            h(
              'div',
              { className: 'km-list' },
              (hits.hits || []).map(function (hit, i) {
                var f = fmtDate(hit.text && hit.text.charAt(0) === '-' ? hit.text : '- ' + hit.text);
                return h(
                  'div',
                  { className: 'km-hit', key: 'hit-' + i },
                  h('div', null, h('span', { className: 'km-date' }, f.date), f.body),
                  h('div', { className: 'km-file' }, hit.file + ' : ' + hit.line),
                );
              }),
            ),
          );
        }
      }

      // 族列表
      var groupRows = (data.groups || []).map(function (g) {
        var isOpen = openSlug === g.slug;
        var row = h(
          'div',
          {
            className: 'km-row' + (isOpen ? ' open' : ''),
            key: 'g-' + g.slug,
            onClick: function () {
              toggle(g.slug);
            },
          },
          h(
            'span',
            null,
            h('span', { className: 'km-slug' }, (isOpen ? '▾ ' : '▸ ') + g.slug),
            g.scope ? h('span', { className: 'km-scope' }, '@' + g.scope) : null,
          ),
          h('span', { className: 'km-count' }, g.entries + ' 条'),
        );

        if (!isOpen) return row;

        var body;
        if (!detail) {
          body = h('div', { className: 'km-body km-empty' }, '读取中…');
        } else if (detail.ok === false) {
          body = h('div', { className: 'km-body km-err' }, detail.error || '读取失败');
        } else {
          var items = (detail.text || '')
            .split('\n')
            .filter(function (line) {
              return line.charAt(0) === '-';
            })
            .map(function (line, i) {
              var f = fmtDate(line);
              return h('div', { className: 'km-item', key: 'i-' + i }, h('span', { className: 'km-date' }, f.date), f.body);
            });
          body = h('div', { className: 'km-body' }, items.length ? items : h('div', { className: 'km-empty' }, '（这一族还没有条目）'));
        }
        return h('div', { key: 'wrap-' + g.slug }, row, body);
      });

      // 体检问题
      var issues = (doctor.issues || []).slice(0, 6).map(function (issue, i) {
        return h('li', { key: 'is-' + i, className: issue.level === 'warn' ? 'km-warn' : 'km-muted' }, '[' + issue.code + '] ' + issue.message);
      });

      // inbox
      var inboxBlock = null;
      if (inboxCount > 0) {
        inboxBlock = h(
          'div',
          null,
          h('div', { className: 'km-muted', style: { marginBottom: '4px' } }, '📥 inbox 待整理'),
          h(
            'div',
            { className: 'km-list' },
            (data.inbox || []).map(function (item, i) {
              var meta = item.meta || {};
              return h(
                'div',
                { className: 'km-row', key: 'in-' + i },
                h('span', { className: 'km-file' }, item.name),
                h('span', { className: 'km-count' }, (meta.messages || 0) + ' 条消息'),
              );
            }),
          ),
        );
      }

      return h(
        'div',
        { className: 'km-panel' },
        h(
          'div',
          { className: 'km-head' },
          h('span', { className: 'km-title' }, '记忆系统'),
          h('span', { className: 'km-muted' }, data.root),
          h(
            'span',
            { className: 'km-muted', style: { cursor: 'pointer', marginLeft: 'auto' }, onClick: function () { setReloadAt(Date.now()); } },
            '↻ 刷新',
          ),
        ),
        cards,
        issues.length ? h('ul', { className: 'km-issues' }, issues) : null,
        h('input', {
          className: 'km-search',
          placeholder: '搜索记忆（中英文均可）…',
          value: query,
          onChange: function (e) {
            setQuery(e.target.value);
          },
        }),
        searchBlock,
        query.trim()
          ? null
          : h('div', { className: 'km-list' }, groupRows),
        query.trim() ? null : inboxBlock,
      );
    }

    // ── 错误隔离 ──────────────────────────────────────────────────────────
    // 插槽组件抛错会连带卸载官方那一整块，所以一律套错误边界。
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }
      static getDerivedStateFromError() {
        return { failed: true };
      }
      componentDidCatch(error) {
        try {
          console.error('[' + PKG + '] 面板渲染失败，已隔离（不影响官方 UI）：', error);
        } catch (e) {
          /* 忽略 */
        }
      }
      render() {
        return this.state.failed ? null : this.props.children;
      }
    }

    function guarded(Inner) {
      function Guarded(props) {
        return h(PanelBoundary, null, h(Inner, props));
      }
      return Guarded;
    }

    // ── 挂载 ──────────────────────────────────────────────────────────────
    function apply(ctx) {
      try {
        ensureStyle();
      } catch (e) {
        /* 样式注入失败不该阻断挂载 */
      }
      try {
        ctx.slots.inject(SLOT, function () {
          return ctx.slots.register(
            {
              name: SLOT,
              id: 'kymemory',
              order: 8,
              label: function () {
                return '记忆';
              },
            },
            guarded(Panel),
          );
        });
      } catch (error) {
        try {
          console.error('[' + PKG + '] 面板插槽注册失败：' + String(error));
        } catch (e) {
          /* 忽略 */
        }
      }
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
