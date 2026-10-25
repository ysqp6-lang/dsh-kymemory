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
      '.km-panel{display:flex;flex-direction:column;gap:0;padding:26px 30px 64px;height:100%;overflow:auto;font-size:14px;line-height:1.6;color:#e8eaed;}',
      '.km-panel *{box-sizing:border-box;}',
      '.km-head{display:flex;align-items:center;gap:14px;margin-bottom:22px;}',
      '.km-title{font-size:18px;font-weight:600;letter-spacing:-.01em;}',
      '.km-root{font-size:11px;color:#666b74;font-family:ui-monospace,Menlo,monospace;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.075);border-radius:7px;padding:3px 9px;}',
      '.km-refresh{margin-left:auto;font-size:12px;color:#8b9099;border:1px solid rgba(255,255,255,.075);border-radius:8px;padding:5px 12px;cursor:pointer;user-select:none;}',
      '.km-refresh:hover{color:#e8eaed;border-color:rgba(255,255,255,.12);background:rgba(255,255,255,.035);}',
      '.km-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:20px;}',
      '.km-card{position:relative;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.075);border-radius:14px;padding:15px 16px 14px;overflow:hidden;}',
      '.km-card::after{content:"";position:absolute;inset:0 0 auto 0;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.10),transparent);}',
      '.km-card-head{display:flex;align-items:center;gap:8px;margin-bottom:11px;}',
      '.km-card-icon{color:#8b9099;width:15px;height:15px;flex:none;}',
      '.km-card-icon svg{width:15px;height:15px;display:block;}',
      '.km-card-title{font-size:11px;color:#8b9099;letter-spacing:.03em;}',
      '.km-card-pct{margin-left:auto;font-size:10.5px;color:#666b74;font-family:ui-monospace,Menlo,monospace;}',
      '.km-card-value{font-size:22px;font-weight:600;letter-spacing:-.02em;line-height:1.15;}',
      '.km-card-value em{font-size:11.5px;font-weight:400;font-style:normal;color:#8b9099;margin-left:2px;}',
      '.km-card-label{font-size:10.5px;color:#666b74;margin-top:5px;line-height:1.5;}',
      '.km-card-row{display:flex;align-items:center;gap:14px;}',
      '.km-card-row > div:first-child{flex:1;min-width:0;}',
      '.km-bar{position:relative;height:6px;border-radius:3px;background:rgba(255,255,255,.07);margin:10px 0 0;overflow:hidden;}',
      '.km-bar::after{content:"";position:absolute;inset:0;border-radius:3px;background:linear-gradient(90deg,#4ecf85 0%,#a8d05a 38%,#e8b45a 62%,#ef7a52 84%,#ec6c6c 100%);clip-path:inset(0 calc(100% - var(--p)) 0 0);transition:clip-path .3s ease;}',
      '.km-ring{width:46px;height:46px;flex:none;}',
      '.km-ring-text{font-size:10px;fill:#8b9099;font-family:ui-monospace,Menlo,monospace;}',
      '.km-card.warn .km-card-value,.km-card.warn .km-card-icon{color:#e8b45a;}',
      '.km-card.ok .km-card-value,.km-card.ok .km-card-icon{color:#5bd18b;}',
      '.km-card.err .km-card-value,.km-card.err .km-card-icon{color:#ec6c6c;}',
      '.km-issues{list-style:none;display:flex;flex-direction:column;gap:5px;margin:0 0 20px;padding:0;}',
      '.km-issue{display:flex;align-items:center;gap:9px;font-size:11.5px;color:#8b9099;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.075);border-radius:9px;padding:7px 11px;}',
      '.km-dot{width:5px;height:5px;border-radius:50%;background:#666b74;flex:none;}',
      '.km-issue.warn .km-dot{background:#e8b45a;}',
      '.km-issue.error .km-dot{background:#ec6c6c;}',
      '.km-code{font-family:ui-monospace,Menlo,monospace;font-size:10px;color:#666b74;flex:none;}',
      '.km-msg{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.km-search-wrap{position:relative;margin-bottom:18px;}',
      '.km-search{width:100%;padding:11px 14px;border-radius:11px;border:1px solid rgba(255,255,255,.075);background:rgba(255,255,255,.035);color:inherit;font-size:13.5px;outline:none;transition:border-color .15s,background .15s;}',
      '.km-search::placeholder{color:#666b74;}',
      '.km-search:focus{border-color:rgba(107,164,255,.5);background:rgba(107,164,255,.04);}',
      '.km-section{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:600;letter-spacing:.04em;color:#666b74;text-transform:uppercase;margin:22px 0 10px;}',
      '.km-section::after{content:"";flex:1;height:1px;background:rgba(255,255,255,.075);}',
      '.km-groups{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;}',
      '.km-group-item{border:1px solid rgba(255,255,255,.075);border-radius:10px;background:rgba(255,255,255,.035);overflow:hidden;transition:border-color .15s,background .15s;}',
      '.km-group-item:hover{border-color:rgba(255,255,255,.12);background:rgba(255,255,255,.055);}',
      '.km-group-item.open{grid-column:1/-1;border-color:rgba(107,164,255,.35);}',
      '.km-row{display:flex;align-items:center;gap:9px;padding:8px 13px;cursor:pointer;}',
      '.km-chev{color:#666b74;font-size:10px;width:10px;flex:none;transition:transform .15s;}',
      '.km-group-item.open .km-chev{transform:rotate(90deg);color:#6ba4ff;}',
      '.km-slug{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;}',
      '.km-scope{font-size:10px;color:#6ba4ff;background:rgba(107,164,255,.12);border-radius:5px;padding:1px 6px;}',
      '.km-count{margin-left:auto;font-size:11px;color:#666b74;background:rgba(255,255,255,.06);border-radius:20px;padding:1px 9px;min-width:30px;text-align:center;}',
      '.km-body{border-top:1px solid rgba(255,255,255,.075);padding:6px 16px 12px 34px;background:rgba(0,0,0,.18);}',
      '.km-entry{display:flex;gap:10px;padding:6px 0;font-size:12.5px;border-bottom:1px dashed rgba(255,255,255,.04);}',
      '.km-entry:last-child{border-bottom:0;}',
      '.km-date{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:#666b74;flex:none;padding-top:2px;}',
      '.km-text{color:#cfd3d8;}',
      '.km-inbox{border:1px solid rgba(255,255,255,.075);border-radius:13px;overflow:hidden;background:rgba(255,255,255,.035);}',
      '.km-inbox-row{display:flex;align-items:center;gap:10px;padding:9px 15px;border-bottom:1px solid rgba(255,255,255,.04);}',
      '.km-inbox-row:last-child{border-bottom:0;}',
      '.km-inbox-date{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:#666b74;flex:none;}',
      '.km-inbox-file{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:#8b9099;}',
      '.km-inbox-meta{margin-left:auto;font-size:10.5px;color:#666b74;flex:none;}',
      '.km-empty{color:#666b74;padding:10px 6px;}',
      '.km-err{color:#ec6c6c;}',
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
    // ── 图标（内联 SVG，静态内容无注入风险）────────────────────────────
    var ICO = {
      layers: '<path d="M12 3 3 7.5 12 12l9-4.5L12 3Z"/><path d="M3 12l9 4.5 9-4.5"/><path d="M3 16.5 12 21l9-4.5"/>',
      grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
      file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/>',
      inbox: '<path d="M3 12h5l2 3h4l2-3h5"/><path d="M5 5h14l2 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5l2-7Z"/>',
      pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
      activity: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    };
    var RING_LEN = 2 * Math.PI * 17;
    function ring(percent, label, invert) {
      var offset = RING_LEN * (1 - percent / 100);
      // invert：覆盖率这类「越高越好」的指标，颜色要反过来取
      var colorPct = invert ? 100 - percent : percent;
      var svg =
        '<svg class="km-ring" viewBox="0 0 44 44">' +
        '<circle cx="22" cy="22" r="17" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="3.5"/>' +
        '<circle cx="22" cy="22" r="17" fill="none" stroke="' + heat(colorPct) + '" stroke-width="3.5" ' +
        'stroke-linecap="round" stroke-dasharray="' + RING_LEN.toFixed(1) + '" ' +
        'stroke-dashoffset="' + offset.toFixed(1) + '" transform="rotate(-90 22 22)"/>' +
        '<text x="22" y="26" text-anchor="middle" class="km-ring-text">' + label + '</text>' +
        '</svg>';
      return h('div', { dangerouslySetInnerHTML: { __html: svg } });
    }

    // 热力色：低=绿、中=黄、高=红（按百分比连续插值）
    function heat(p) {
      var clamped = Math.max(0, Math.min(100, p));
      var hue = 142 - clamped * 1.32;
      return 'hsl(' + hue.toFixed(0) + ', 64%, 56%)';
    }

    // 进度条：整条铺绿→黄→红渐变，按进度用 clip-path 裁出可见部分，
    // 所以 57% 看到的是「绿到黄」，96% 才看得到红。
    function bar(percent) {
      var p = Math.max(0, Math.min(100, percent)).toFixed(1) + '%';
      return h('div', { className: 'km-bar', style: { '--p': p } });
    }

    function icon(name) {
      var svg =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
        'stroke-linecap="round" stroke-linejoin="round">' +
        (ICO[name] || '') +
        '</svg>';
      return h('div', { className: 'km-card-icon', dangerouslySetInnerHTML: { __html: svg } });
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
            var detail2 = String(e && e.message ? e.message : e);
            setError(detail2 + ' ｜ 请求地址：' + apiUrl('/overview') + ' ｜ 页面：' + window.location.href);
          });
        return function () {
          alive = false;
        };
      }, [reloadAt]);

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
      var inbox = data.inbox || [];
      var health = counts.error > 0 ? 'err' : counts.warn > 0 ? 'warn' : 'ok';

      function head(name, title, pctLabel) {
        return h(
          'div',
          { className: 'km-card-head' },
          icon(name),
          h('span', { className: 'km-card-title' }, title),
          pctLabel ? h('span', { className: 'km-card-pct' }, pctLabel) : null,
        );
      }
      var pctOf = function (a, b) {
        return b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0;
      };
      var indexPct = pctOf(data.index.bytes, data.limits.maxIndexBytes);
      var maxEntries = (data.groups || []).reduce(function (m, g) {
        return Math.max(m, g.entries || 0);
      }, 0);
      var maxPct = pctOf(maxEntries, data.route.entries);
      var inboxPct = pctOf(inbox.length, 50);
      var recallPct = pctOf((data.usage && data.usage.used) || 0, (data.usage && data.usage.total) || 1);
      var healthPct = counts.error > 0 ? 30 : counts.warn > 0 ? 70 : 100;

      var cards = h(
        'div',
        { className: 'km-cards' },
        // 索引：进度条
        h(
          'div',
          { className: 'km-card' },
          head('layers', '索引', indexPct.toFixed(0) + '%'),
          h('div', { className: 'km-card-value' }, data.index.lines, h('em', null, '行')),
          bar(indexPct),
          h('div', { className: 'km-card-label' }, kb(data.index.bytes) + ' / ' + kb(data.limits.maxIndexBytes) + ' 预算'),
        ),
        // 任务族：最大族占比条
        h(
          'div',
          { className: 'km-card' },
          head('grid', '任务族', '最大 ' + maxPct.toFixed(0) + '%'),
          h('div', { className: 'km-card-value' }, data.route.groups, h('em', null, '族 · ' + data.route.entries + ' 条')),
          bar(maxPct),
          h('div', { className: 'km-card-label' }, '最大族 ' + maxEntries + ' 条，其余为长尾'),
        ),
        // 证据：纯计数 + 说明
        h(
          'div',
          { className: 'km-card' },
          head('file', '证据'),
          h('div', { className: 'km-card-value' }, data.evidence, h('em', null, '个文件')),
          h('div', { className: 'km-card-label', style: { marginTop: '10px' } }, 'summaries/ 存放命令输出与实测细节，MEMORY.md 只留一行指针。'),
        ),
        // inbox：进度条（上限 50）
        h(
          'div',
          { className: 'km-card ' + (inbox.length > 0 ? 'warn' : '') },
          head('inbox', 'inbox', inboxPct.toFixed(0) + '%'),
          h('div', { className: 'km-card-value' }, inbox.length, h('em', null, '个待整理')),
          bar(inboxPct),
          h('div', { className: 'km-card-label' }, '上限 50 个后自动归档'),
        ),
        // 体检：圆环
        h(
          'div',
          { className: 'km-card ' + health },
          head('pulse', '体检'),
          h(
            'div',
            { className: 'km-card-row' },
            h(
              'div',
              null,
              h('div', { className: 'km-card-value' }, doctor.ok ? '正常' : '有问题'),
              h('div', { className: 'km-card-label' }, (counts.error || 0) + ' 错误 · ' + (counts.warn || 0) + ' 警告'),
            ),
            ring(healthPct, healthPct.toFixed(0) + '%'),
          ),
        ),
        // recall 覆盖：圆环
        h(
          'div',
          { className: 'km-card' },
          head('activity', 'recall 覆盖'),
          h(
            'div',
            { className: 'km-card-row' },
            h(
              'div',
              null,
              h(
                'div',
                { className: 'km-card-value' },
                (data.usage && data.usage.used) || 0,
                h('em', null, '/ ' + ((data.usage && data.usage.total) || 0) + ' 族'),
              ),
              h('div', { className: 'km-card-label' }, recallPct.toFixed(0) + '% 的族被整族取过（越低越该留意）'),
            ),
            ring(recallPct, recallPct.toFixed(0) + '%', true),
          ),
        ),
      );

      var issues = (doctor.issues || []).slice(0, 6).map(function (issue, i) {
        return h(
          'li',
          { className: 'km-issue ' + issue.level, key: 'is-' + i },
          h('span', { className: 'km-dot' }),
          h('span', { className: 'km-code' }, issue.code),
          h('span', { className: 'km-msg' }, issue.message),
        );
      });

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
            h('div', { className: 'km-section' }, '命中 ' + hits.total + ' 条'),
            h(
              'div',
              null,
              (hits.hits || []).map(function (hit, i) {
                var f = fmtDate(hit.text && hit.text.charAt(0) === '-' ? hit.text : '- ' + hit.text);
                return h(
                  'div',
                  { className: 'km-entry', key: 'hit-' + i },
                  h('span', { className: 'km-date' }, f.date),
                  h(
                    'span',
                    { className: 'km-text' },
                    f.body,
                    h('span', { className: 'km-code', style: { marginLeft: '8px' } }, hit.file + ':' + hit.line),
                  ),
                );
              }),
            ),
          );
        }
      }

      // 族列表
      var groupItems = (data.groups || []).map(function (g) {
        var isOpen = openSlug === g.slug;
        var row = h(
          'div',
          {
            className: 'km-row',
            key: 'g-' + g.slug,
            onClick: function () {
              toggle(g.slug);
            },
          },
          h('span', { className: 'km-chev' }, '▸'),
          h('span', { className: 'km-slug' }, g.slug),
          g.scope ? h('span', { className: 'km-scope' }, '@' + g.scope.split('/').pop()) : null,
          h('span', { className: 'km-count' }, g.entries),
        );

        var body = null;
        if (isOpen) {
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
                return h(
                  'div',
                  { className: 'km-entry', key: 'e-' + i },
                  h('span', { className: 'km-date' }, f.date),
                  h('span', { className: 'km-text' }, f.body),
                );
              });
            body = h('div', { className: 'km-body' }, items.length ? items : h('div', { className: 'km-empty' }, '（这一族还没有条目）'));
          }
        }

        return h('div', { className: 'km-group-item' + (isOpen ? ' open' : ''), key: 'gi-' + g.slug }, row, body);
      });

      // inbox
      var inboxBlock = null;
      if (inbox.length > 0) {
        inboxBlock = h(
          'div',
          null,
          h('div', { className: 'km-section' }, 'inbox 待整理 · ' + inbox.length),
          h(
            'div',
            { className: 'km-inbox' },
            inbox.map(function (item, i) {
              var m = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/.exec(item.name || '');
              var date = m ? m[1].slice(5) : '';
              var sid = m ? m[2].replace(/^session-/, '').slice(0, 8) : item.name || '';
              var meta = item.meta || {};
              return h(
                'div',
                { className: 'km-inbox-row', key: 'in-' + i },
                h('span', { className: 'km-inbox-date' }, date),
                h('span', { className: 'km-inbox-file' }, 'session-' + sid),
                h('span', { className: 'km-inbox-meta' }, (meta.messages || 0) + ' 条消息'),
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
          h('span', { className: 'km-root' }, data.root),
          h(
            'span',
            { className: 'km-refresh', onClick: function () { setReloadAt(Date.now()); } },
            '↻ 刷新',
          ),
        ),
        cards,
        issues.length ? h('ul', { className: 'km-issues' }, issues) : null,
        h('div', { className: 'km-search-wrap' },
          h('input', {
            className: 'km-search',
            placeholder: '搜索记忆（中英文均可，跨路由层与证据层）…',
            value: query,
            onChange: function (e) { setQuery(e.target.value); },
          }),
        ),
        searchBlock,
        query.trim() ? null : inboxBlock,
        query.trim() ? null : h('div', null,
          h('div', { className: 'km-section' }, '任务族 · ' + data.route.groups),
          h('div', { className: 'km-groups' }, groupItems),
        ),
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
