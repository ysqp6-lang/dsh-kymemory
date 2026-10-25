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
      '.km-push{margin-left:auto;}',
      '.km-root{font-size:11px;color:#666b74;font-family:ui-monospace,Menlo,monospace;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.075);border-radius:7px;padding:3px 9px;}',
      '.km-refresh{font-size:12px;color:#8b9099;border:1px solid rgba(255,255,255,.075);border-radius:8px;padding:5px 12px;cursor:pointer;user-select:none;}',
      '.km-refresh:hover{color:#e8eaed;border-color:rgba(255,255,255,.12);background:rgba(255,255,255,.035);}',
      '.km-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:20px;}',
      '.km-card.clickable{cursor:pointer;transition:border-color .15s,background .15s;}',
      '.km-card.clickable:hover{border-color:rgba(255,255,255,.14);background:rgba(255,255,255,.055);}',
      '.km-card.active{border-color:rgba(107,164,255,.45);background:rgba(107,164,255,.06);}',
      '.km-btn{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:6px 13px;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#e8eaed;cursor:pointer;transition:background .15s,border-color .15s;}',
      '.km-btn:hover{background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.2);}',
      '.km-btn.primary{border-color:rgba(107,164,255,.45);background:rgba(107,164,255,.14);color:#cfe0ff;}',
      '.km-btn.primary:hover{background:rgba(107,164,255,.22);}',
      '.km-btn:disabled{opacity:.4;cursor:not-allowed;}',
      '.km-btn-row{display:flex;gap:9px;margin-top:14px;}',
      '.km-tidy-item{display:flex;align-items:center;gap:10px;padding:7px 0;font-size:12.5px;border-bottom:1px dashed rgba(255,255,255,.05);}',
      '.km-tidy-item:last-child{border-bottom:0;}',
      '.km-tidy-check{width:15px;height:15px;flex:none;accent-color:#6ba4ff;}',
      '.km-tidy-name{flex:1;}',
      '.km-tidy-count{font-size:11px;color:#8b9099;font-family:ui-monospace,Menlo,monospace;}',
      '.km-detail{margin:-8px 0 20px;border:1px solid rgba(255,255,255,.09);border-radius:14px;background:rgba(255,255,255,.03);padding:15px 18px;}',
      '.km-detail-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;}',
      '.km-detail-title{font-size:13px;font-weight:600;}',
      '.km-detail-close{margin-left:auto;font-size:11px;color:#666b74;cursor:pointer;padding:2px 6px;border-radius:5px;}',
      '.km-detail-close:hover{color:#e8eaed;background:rgba(255,255,255,.06);}',
      '.km-d-row{display:flex;gap:12px;padding:5px 0;font-size:12.5px;border-bottom:1px dashed rgba(255,255,255,.05);}',
      '.km-d-row:last-child{border-bottom:0;}',
      '.km-d-key{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#8b9099;flex:none;min-width:130px;}',
      '.km-d-val{color:#cfd3d8;flex:1;min-width:0;}',
      '.km-d-note{font-size:11.5px;color:#9aa0a8;line-height:1.7;margin-top:11px;padding:9px 12px;background:rgba(107,164,255,.06);border-left:2px solid rgba(107,164,255,.45);border-radius:0 7px 7px 0;}',
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
      var s7 = React.useState(null);
      var openCard = s7[0], setOpenCard = s7[1];
      var s8 = React.useState(null);
      var tidy = s8[0], setTidy = s8[1];
      var s9 = React.useState(null);
      var tidyMsg = s9[0], setTidyMsg = s9[1];

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

      function cardWrap(key, className, children) {
        var active = openCard === key;
        return h(
          'div',
          {
            className: 'km-card clickable ' + (className || '') + (active ? ' active' : ''),
            onClick: function () {
              setOpenCard(active ? null : key);
            },
          },
          children,
        );
      }

      var cards = h(
        'div',
        { className: 'km-cards' },
        cardWrap('index', '', [
          head('layers', '索引', indexPct.toFixed(0) + '%'),
          h('div', { className: 'km-card-value' }, data.index.lines, h('em', null, '行')),
          bar(indexPct),
          h('div', { className: 'km-card-label' }, kb(data.index.bytes) + ' / ' + kb(data.limits.maxIndexBytes) + ' 预算'),
        ]),
        cardWrap('groups', '', [
          head('grid', '任务族', '最大 ' + maxPct.toFixed(0) + '%'),
          h('div', { className: 'km-card-value' }, data.route.groups, h('em', null, '族 · ' + data.route.entries + ' 条')),
          bar(maxPct),
          h('div', { className: 'km-card-label' }, '最大族 ' + maxEntries + ' 条，其余为长尾'),
        ]),
        cardWrap('evidence', '', [
          head('file', '证据'),
          h('div', { className: 'km-card-value' }, data.evidence, h('em', null, '个文件')),
          h('div', { className: 'km-card-label', style: { marginTop: '10px' } }, 'summaries/ 存放命令输出与实测细节，MEMORY.md 只留一行指针。'),
        ]),
        cardWrap('inbox', inbox.length > 0 ? 'warn' : '', [
          head('inbox', 'inbox', inboxPct.toFixed(0) + '%'),
          h('div', { className: 'km-card-value' }, inbox.length, h('em', null, '个待整理')),
          bar(inboxPct),
          h('div', { className: 'km-card-label' }, '上限 50 个后自动归档'),
        ]),
        cardWrap('health', health, [
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
        ]),
        cardWrap('recall', '', [
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
        ]),
      );

      // ── 卡片详情：点开看「是什么、为什么、怎么办」────────────────────
      var CARD_TITLES = {
        index: '索引层 · memory_summary.md',
        groups: '任务族 · MEMORY.md',
        evidence: '证据层 · summaries/',
        inbox: 'inbox · 自动捕获的候选',
        health: '体检 · memory_doctor',
        recall: 'recall 覆盖 · usage.json',
      };
      function detailRows(key) {
        var rows = [];
        var note = '';
        if (key === 'index') {
          var remain = Math.max(0, data.limits.maxIndexBytes - data.index.bytes);
          rows = [
            ['行数', data.index.lines + ' 行'],
            ['当前占用', kb(data.index.bytes)],
            ['预算上限', kb(data.limits.maxIndexBytes) + '（超出会被截断）'],
            ['剩余空间', kb(remain)],
          ];
          note = '索引是每次会话都注入模型上下文的那段文字，所以它的每一字节都是「每轮成本」。写满了就该把细节下沉到 MEMORY.md 或 summaries/。';
        } else if (key === 'groups') {
          var sorted = (data.groups || []).slice().sort(function (a, b) {
            return b.entries - a.entries;
          });
          rows = sorted.slice(0, 10).map(function (g) {
            var scope = g.scope ? '  @' + String(g.scope).split('/').pop() : '';
            return [g.slug, g.entries + ' 条' + scope];
          });
          if (sorted.length > 10) rows.push(['…', '另有 ' + (sorted.length - 10) + ' 个更小的族']);
          note = '按条目数排序的前 10 个族。单族超过 50 条时体检会提示拆分——把细节挪到 summaries/，MEMORY.md 里只留一行指针。';
        } else if (key === 'evidence') {
          var files = data.evidenceFiles || [];
          rows = files.length
            ? files.map(function (f) {
                return [f.name, kb(f.bytes)];
              })
            : [['—', '还没有证据文件']];
          note = '证据层存原始材料：命令输出、实测数据、复现步骤。MEMORY.md 的条目用一行指针指过来，需要时才读。';
        } else if (key === 'inbox') {
          var items = data.inbox || [];
          rows = items.length
            ? items.map(function (it) {
                var m = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/.exec(it.name || '');
                var meta = it.meta || {};
                return [m ? m[1] : it.name || '', 'session-' + (m ? m[2].replace(/^session-/, '').slice(0, 8) : '') + ' · ' + (meta.messages || 0) + ' 条消息'];
              })
            : [['—', '队列是空的，暂时没有要整理的']];
          note = '这些是自动捕获的候选素材，还没进正式记忆。让本鲸用 memory_inbox 读出来、提炼后 memory_save 入库，再 memory_promote 归档。超过 30 天未处理会自动归档。';
        } else if (key === 'health') {
          var iss = data.doctor.issues || [];
          rows = iss.length
            ? iss.map(function (i) {
                return ['[' + i.code + ']', i.message];
              })
            : [['—', '所有检查项都通过了']];
          note = '体检覆盖：重复任务族、疑似矛盾（同族内高度相似但否定词只在一边）、索引超限、孤儿证据、失效路由、缺日期条目、作用域路径失效、用量分析。error 会阻止正常使用，warn/info 只是建议。';
        } else if (key === 'recall') {
          var never = (data.usage && data.usage.neverUsed) || [];
          rows = never.length
            ? never.slice(0, 18).map(function (s) {
                return [s, '从未被整族取过'];
              })
            : [['—', '所有任务族都至少被取用过一次']];
          if (never.length > 18) rows.push(['…', '另有 ' + (never.length - 18) + ' 个']);
          note = '注意：这不等于没用——memory_search 命中同样会用到内容，只是不计入本统计。如果确实长期不用，可以：① 用 memory_archive 归档；② 让本鲸下次相关任务时主动 recall；③ 关掉自动捕获减少新的无主积累。';
        }
        return { rows: rows, note: note };
      }
      // ── 整理面板 ──────────────────────────────────────────────────────
      var TIDY_LABELS = {
        'duplicate-entry': '删除完全重复的条目',
        'missing-scope-path': '移除失效的作用域标记',
        'blank-lines': '合并连续空行',
        'stale-inbox': '归档超过 30 天的 inbox 候选',
      };
      var tidyPanel = null;
      if (tidy) {
        var items = tidy.items || [];
        tidyPanel = h(
          'div',
          { className: 'km-detail' },
          h(
            'div',
            { className: 'km-detail-head' },
            h('span', { className: 'km-detail-title' }, '整理 · 只做结构层面确定安全的修复'),
            h('span', { className: 'km-detail-close', onClick: function () { setTidy(null); setTidyMsg(null); } }, '收起 ✕'),
          ),
          items.length
            ? items.map(function (it, i) {
                return h(
                  'div',
                  { className: 'km-tidy-item', key: 'ti-' + i },
                  h('input', { className: 'km-tidy-check', type: 'checkbox', defaultChecked: true, 'data-kind': it.kind }),
                  h('span', { className: 'km-tidy-name' }, TIDY_LABELS[it.kind] || it.kind),
                  h('span', { className: 'km-tidy-count' }, it.count + ' 处'),
                );
              })
            : h('div', { className: 'km-empty' }, '没有发现可以自动修复的问题，剩下的都需要人工判断。'),
          h(
            'div',
            { className: 'km-detail-note' },
            '动手前会自动把 MEMORY.md 备份到 archive/MEMORY.md.bak-tidy-<时间>。这里只删完全重复的行、去掉失效的 @路径、合并空行、归档过期候选——不会改写任何记忆内容。',
          ),
          h(
            'div',
            { className: 'km-btn-row' },
            h(
              'button',
              {
                className: 'km-btn primary',
                disabled: items.length === 0,
                onClick: function () {
                  var kinds = [];
                  var boxes = document.querySelectorAll('.km-tidy-check');
                  for (var i = 0; i < boxes.length; i++) {
                    if (boxes[i].checked) kinds.push(boxes[i].getAttribute('data-kind'));
                  }
                  if (kinds.length === 0) {
                    setTidyMsg('没有勾选任何项目');
                    return;
                  }
                  getJson('/tidy?action=apply&kinds=' + encodeURIComponent(kinds.join(',')))
                    .then(function (d) {
                      if (d && d.ok !== false) {
                        setTidyMsg('已修复：' + (d.applied || []).map(function (a) { return a.kind + '(' + a.removed + ')'; }).join('、') + '，备份在 ' + d.backup);
                        setReloadAt(Date.now());
                        getJson('/tidy?action=preview').then(function (p2) { setTidy(p2 && p2.ok !== false ? p2 : { items: [] }); });
                      } else {
                        setTidyMsg('修复失败：' + ((d && d.error) || '未知错误'));
                      }
                    })
                    .catch(function (e) { setTidyMsg('修复失败：' + String(e)); });
                },
              },
              '备份并修复勾选项',
            ),
            h(
              'button',
              {
                className: 'km-btn',
                onClick: function () {
                  getJson('/tidy?action=undo')
                    .then(function (d) {
                      if (d && d.ok !== false) {
                        setTidyMsg('已撤销，从 ' + d.restoredFrom + ' 恢复');
                        setReloadAt(Date.now());
                      } else {
                        setTidyMsg('撤销失败：' + ((d && d.error) || '没有可撤销的记录'));
                      }
                    })
                    .catch(function (e) { setTidyMsg('撤销失败：' + String(e)); });
                },
              },
              '撤销上次整理',
            ),
          ),
          tidyMsg ? h('div', { className: 'km-detail-note', style: { borderLeftColor: 'rgba(91,209,139,.6)', background: 'rgba(91,209,139,.06)' } }, tidyMsg) : null,
        );
      }

      var detail = null;
      if (openCard) {
        var d = detailRows(openCard);
        detail = h(
          'div',
          { className: 'km-detail' },
          h(
            'div',
            { className: 'km-detail-head' },
            h('span', { className: 'km-detail-title' }, CARD_TITLES[openCard] || ''),
            h(
              'span',
              {
                className: 'km-detail-close',
                onClick: function (e) {
                  e.stopPropagation();
                  setOpenCard(null);
                },
              },
              '收起 ✕',
            ),
          ),
          d.rows.map(function (r, i) {
            return h(
              'div',
              { className: 'km-d-row', key: 'dr-' + i },
              h('span', { className: 'km-d-key' }, r[0]),
              h('span', { className: 'km-d-val' }, r[1]),
            );
          }),
          d.note ? h('div', { className: 'km-d-note' }, d.note) : null,
        );
      }

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
            {
              className: 'km-refresh km-push',
              onClick: function () {
                getJson('/tidy?action=preview')
                  .then(function (d) {
                    setTidy(d && d.ok !== false ? d : { items: [] });
                    setTidyMsg(null);
                  })
                  .catch(function (e) {
                    setTidyMsg('读取可修复项失败：' + String(e));
                  });
              },
            },
            '整理',
          ),
          h(
            'span',
            { className: 'km-refresh', onClick: function () { setReloadAt(Date.now()); } },
            '↻ 刷新',
          ),
        ),
        cards,
        tidyPanel,
        detail,
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
