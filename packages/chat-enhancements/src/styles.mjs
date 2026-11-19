export function chatCss(externalWeeklyUsage = false, externalKits = []) {
  const speedAndHistory = [externalKits.includes('output-speed') ? '' : '.codex-output-token-speed', externalKits.includes('history-show-all') ? '' : '.codex-turn-history-all'].filter(Boolean).join(',');
  return [
    externalKits.includes('selection-actions-delay') ? '' : selectionActionsCss(),
    externalWeeklyUsage ? '' : '#codex-usage-toolbar .codex-usage-hard-reset{position:absolute;top:0;right:0;height:2px;z-index:1;background:#ef4444;pointer-events:auto}',
    speedAndHistory ? speedHistoryCss(speedAndHistory) : '',
    modelDecorationsCss({ emoji: !externalKits.includes('title-emoji'), fast: !externalKits.includes('fast-mode-indicator'), warning: !externalKits.includes('child-model-warning') }),
    externalKits.includes('history-show-all') ? '' : historyControlCss(),
    externalKits.includes('message-labels') ? '' : messageLabelsCss(),
    externalKits.includes('composer-timer') ? '' : composerTimerCss(),
    externalKits.includes('live-model-output') ? '' : liveOutputCss(),
    externalKits.includes('context-meter') ? '' : contextUsageCss(),
    externalWeeklyUsage ? '' : weeklyUsageCss(),
    externalKits.includes('table-style') ? '' : tableStyleCss(),
    externalKits.includes('image-viewer-close') ? '' : imageViewerCloseCss(),
    '.cdtk-chat-hidden .codex-context-usage-surface::after,.cdtk-chat-hidden .codex-composer-running-bar::before{animation-play-state:paused!important}',
    externalKits.includes('context-meter') ? '' : contextUsageTicksCss(),
  ].join('');
}

export function historyControlCss() {
  return ".codex-turn-history-row{display:flex;align-items:center;justify-content:space-between;gap:8px}.codex-turn-history-all{position:static;display:inline-flex;flex:none;align-items:center;pointer-events:auto;cursor:pointer;font-weight:inherit}.codex-turn-history-all[hidden]{display:none!important}.codex-turn-history-all:hover{color:var(--color-token-foreground,light-dark(#1a1c1f,#dce3ee))}.codex-turn-history-all:disabled{cursor:wait;opacity:.7}.codex-turn-history-all[data-result=\"error\"]{color:#fca5a5}";
}

export function messageLabelsCss() {
  return [
    ".codex-message-label{position:static;anchor-name:var(--cdt-message-host-anchor),var(--cdt-message-end-anchor)}.codex-message-label,.codex-message-tool-rail{--cdt-message-rail-color:var(--cdt-message-number-color)}.codex-message-rail-scope{anchor-scope:var(--cdt-message-number-anchors)}",
    ".codex-message-label[data-cdt-message-number]::before{content:attr(data-cdt-message-number);position:absolute;left:auto;right:calc(anchor(var(--cdt-message-host-anchor) left) + 4px);top:anchor(var(--cdt-message-number-anchor) top,anchor(var(--cdt-message-host-anchor) top));bottom:anchor(var(--cdt-message-host-anchor) bottom);width:max-content;text-align:right;white-space:nowrap;font-size:15px;line-height:1;font-weight:600;font-style:normal;font-variant-numeric:tabular-nums;color:var(--cdt-message-number-color);anchor-name:var(--cdt-message-number-box-anchor);background:linear-gradient(var(--cdt-message-rail-color),var(--cdt-message-rail-color)) right calc(.5ch - .5px) bottom/1px max(0px,calc(100% - 17px)) no-repeat;pointer-events:none;user-select:none}",
    ".codex-message-label[data-cdt-message-time]::after{content:attr(data-cdt-message-time);position:absolute;left:anchor(var(--cdt-message-number-box-anchor) left,calc(anchor(var(--cdt-message-host-anchor) left) - 24px));top:calc((anchor(var(--cdt-message-previous-end,--cdt-message-no-previous) bottom,calc(anchor(var(--cdt-message-number-box-anchor) top,anchor(var(--cdt-message-host-anchor) top)) - var(--conversation-item-gap,16px))) + anchor(var(--cdt-message-number-box-anchor) top,anchor(var(--cdt-message-host-anchor) top))) / 2);transform:translateY(-50%);font-size:15px;line-height:min(18px,var(--conversation-item-gap,16px));color:light-dark(#5b616b,#9298a2);pointer-events:none;user-select:none;font-variant-numeric:tabular-nums;white-space:nowrap}",
    "[data-cdt-message-number-label]::before{content:attr(data-cdt-message-number-label);display:inline-block;position:relative;right:4px;width:0;text-align:right;white-space:nowrap;vertical-align:top;visibility:hidden;font-size:15px;line-height:1;font-weight:600;font-style:normal;font-variant-numeric:tabular-nums;color:var(--cdt-message-number-color);anchor-name:var(--cdt-message-number-anchor);pointer-events:none;user-select:none}.codex-message-tool-rail{position:relative;anchor-name:var(--cdt-message-end-anchor)}.codex-message-tool-rail::before{content:\"\";position:absolute;left:calc(-4px - .5ch - .5px);top:calc(-1 * var(--conversation-item-gap,16px));bottom:0;width:1px;font-size:15px;font-weight:600;font-style:normal;font-variant-numeric:tabular-nums;background:var(--cdt-message-rail-color);pointer-events:none;user-select:none}[class*=\"container-name:thread-content\"]:has(.codex-message-label){overflow-x:visible}",
  ].join('');
}

export function tableStyleCss() {
  return '[data-markdown-text-style="assistant-message"] table{font-size:var(--markdown-font-size)!important}[data-markdown-text-style="assistant-message"] table tr>:is(th,td):not(:last-child){border-inline-end:1px solid var(--border-medium)!important}[data-markdown-text-style="assistant-message"] table tbody>tr:not(:last-child)>:is(th,td){border-bottom:1px solid var(--border-medium)!important}';
}

export function imageViewerCloseCss() {
  return '[role="dialog"]:has([data-testid="image-preview-dismiss-area"]) button[aria-label="Close image preview"]{color:#ff4d4f!important}';
}

export function selectionActionsCss() {
  return '.codex-selection-actions-delayed{visibility:hidden!important;opacity:0!important;transition:opacity 500ms ease!important}.codex-selection-actions-delayed.codex-selection-actions-ready{visibility:visible!important;opacity:1!important}.codex-selection-actions-delayed:not(.codex-selection-actions-interactive),.codex-selection-actions-delayed:not(.codex-selection-actions-interactive) *{pointer-events:none!important}';
}

export function speedHistoryCss(selector) {
  return selector + '{position:fixed;z-index:12;display:none;pointer-events:none;user-select:none;padding:3px 7px;border:1px solid color-mix(in srgb,var(--cdtk-accent,var(--color-token-border-light,#7d8695)) 35%,transparent);border-radius:6px;background:color-mix(in srgb,var(--cdtk-surface,var(--color-token-main-surface-primary,light-dark(#ffffff,#10131b))) 88%,transparent);box-shadow:0 2px 10px #0004;color:var(--color-token-text-secondary,light-dark(#4b5563,#aab4c4));font-family:"Segoe UI Variable",system-ui,sans-serif;font-size:calc(var(--codex-chat-font-size,var(--text-base,13px)) * .86);font-variant-numeric:tabular-nums;line-height:1.2;white-space:nowrap;backdrop-filter:blur(8px)}';
}

export function modelDecorationsCss(features = {}) {
  const enabled = { emoji: true, fast: true, warning: true, ...features };
  const indicators = [enabled.emoji ? '#codex-thread-emoji-indicator' : '', enabled.fast ? '#codex-thread-speed-indicator' : ''].filter(Boolean).join(',');
  return [
    enabled.fast ? 'svg[class*="ModelPickerTriggerInlineModeIcon"]{width:18px!important;height:18px!important;color:#f7c948!important;filter:drop-shadow(0 0 4px rgba(247,201,72,.6))}' : '',
    enabled.warning ? '.codex-inherited-model-warning{background-image:linear-gradient(to top,rgba(180,55,55,.66) 0%,transparent 100%)!important;background-position:left bottom!important;background-repeat:no-repeat!important;background-size:100% 25%!important}' : '',
    indicators ? indicators + '{position:absolute;z-index:4;bottom:calc(100% + 12px);width:200px;height:180px;pointer-events:none;user-select:none;font-family:"Segoe UI Emoji",sans-serif;font-size:150px;font-weight:700;line-height:180px;opacity:.3;text-shadow:0 0 18px currentColor}' : '',
    enabled.emoji ? '#codex-thread-emoji-indicator{left:0;text-align:left}' : '',
    enabled.fast ? '#codex-thread-speed-indicator{right:0;text-align:right;color:var(--cdtk-accent,#f7c948)}' : '',
  ].join('');
}

export function composerTimerCss() {
  return [
    '@keyframes cdt-composer-running-flow{from{background-position:0 0}to{background-position:120px 0}}[data-cdt-running-composer-host]{anchor-scope:--cdt-running-composer}[data-cdt-running-composer-surface]{anchor-name:--cdt-running-composer}.codex-composer-running-bar{display:none;position:absolute;position-anchor:--cdt-running-composer;left:anchor(left);right:anchor(right);top:anchor(bottom);bottom:0;border-radius:999px;overflow:hidden;pointer-events:none!important;user-select:none;background:repeating-linear-gradient(135deg,#2389ff 0 42.4264068712px,#1056a8 42.4264068712px 84.8528137424px);background-size:120px 120px;animation:cdt-composer-running-flow 3s linear infinite}[data-cdt-running-composer-host][data-cdt-composer-working="true"]>.codex-composer-running-bar{display:block}',
    '.codex-composer-running-bar{display:flex;align-items:center;justify-content:center;left:anchor(center);right:auto;transform:translateX(-50%);width:max-content;box-sizing:border-box;padding:0 7px;border:1px solid color-mix(in srgb,var(--cdtk-accent,var(--color-token-border-light,#7d8695)) 35%,transparent);background:none;animation:none;color:var(--color-token-text-secondary,light-dark(#4b5563,#aab4c4));font-family:"Segoe UI Variable",system-ui,sans-serif;font-size:12px;line-height:1;white-space:nowrap;font-variant-numeric:tabular-nums;interpolate-size:allow-keywords;transition:width 500ms cubic-bezier(.215,.61,.355,1),color 500ms cubic-bezier(.215,.61,.355,1),border-color 500ms cubic-bezier(.215,.61,.355,1)}.codex-composer-running-bar::before{content:"";position:absolute;inset:0;z-index:-1;background:repeating-linear-gradient(135deg,#2389ff 0 42.4264068712px,#1056a8 42.4264068712px 84.8528137424px);background-size:120px 120px;animation:cdt-composer-running-flow 3s linear infinite;animation-play-state:paused;opacity:0;transition:opacity 500ms cubic-bezier(.215,.61,.355,1)}[data-cdt-running-composer-host][data-cdt-composer-working="true"]>.codex-composer-running-bar{display:flex;width:anchor-size(width);color:#fff;border-color:transparent}[data-cdt-running-composer-host][data-cdt-composer-working="true"]>.codex-composer-running-bar::before{opacity:1;animation-play-state:running}',
    '.codex-composer-running-bar,.codex-composer-running-bar::before{transition-duration:2s}[data-cdt-running-composer-host][data-cdt-composer-working="true"]>.codex-composer-running-bar,[data-cdt-running-composer-host][data-cdt-composer-working="true"]>.codex-composer-running-bar::before{transition-duration:500ms}',
  ].join('');
}

export function liveOutputCss() {
  return [
    '.codex-composer-running-bar[data-cdt-live-thread-id]{pointer-events:auto!important;cursor:pointer}.codex-live-output-overlay{position:absolute;position-anchor:--cdt-running-composer;left:anchor(left);top:anchor(top);width:anchor-size(width);height:anchor-size(height);z-index:70;box-sizing:border-box;border:0;border-radius:0!important;padding:2px;margin:0;background:light-dark(#dbeafe,#1056a8);color:light-dark(#172f53,var(--color-token-text-primary,var(--color-token-foreground)));font-family:inherit;font-size:12px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;overflow-y:scroll!important;overflow-x:hidden;scrollbar-width:auto!important;scrollbar-gutter:stable;pointer-events:auto;user-select:text}.codex-live-output-overlay[hidden]{display:none!important}.codex-live-output-overlay::-webkit-scrollbar{display:block!important;width:10px!important}.codex-live-output-overlay::-webkit-scrollbar-track{background:light-dark(#dbeafe,#1056a8)}.codex-live-output-overlay::-webkit-scrollbar-thumb{background:light-dark(#4777a9,#8ab6e6);border:2px solid light-dark(#dbeafe,#1056a8);border-radius:0}',
    '.codex-live-output-entry{display:block;margin:0;padding:0;border:0;background:light-dark(#dbeafe,#1056a8)}.codex-live-output-entry-even{background:light-dark(#bfdbfe,#0d4586)}',
    '.codex-live-output-overlay{top:calc(anchor(top) + 3px);height:calc(anchor-size(height) - 3px)}',
  ].join('');
}

export function contextUsageCss() {
  return '@keyframes cdt-context-usage-pulse{0%,100%{opacity:1}50%{opacity:.2}}.codex-context-usage-surface::after{content:"";position:absolute;top:1px;left:0;width:var(--cdt-context-usage-width);height:2px;background:var(--cdt-context-usage-color);border-radius:1px;z-index:5;pointer-events:none;animation:var(--cdt-context-usage-animation,none)}';
}

export function contextUsageTicksCss() {
  const ticks = Array.from({ length: 9 }, (_, index) => {
    const percent = (index + 1) * 10;
    return 'transparent calc(' + percent + '% - 1px),light-dark(rgba(0,0,0,.5),rgba(255,255,255,.5)) calc(' + percent + '% - 1px),light-dark(rgba(0,0,0,.5),rgba(255,255,255,.5)) calc(' + percent + '% + 1px),transparent calc(' + percent + '% + 1px)';
  }).join(',');
  return '.codex-context-usage-surface::before{content:"";position:absolute;top:1px;left:0;width:100%;height:2px;background:linear-gradient(to right,' + ticks + ');z-index:6;pointer-events:none}';
}

export function weeklyUsageCss() {
  return "#codex-usage-toolbar .codex-usage-summary{position:relative;display:inline-flex;flex:0 0 auto;white-space:nowrap}#codex-usage-toolbar .codex-usage-progress{position:absolute;left:0;right:0;height:2px;pointer-events:none;isolation:isolate;background:color-mix(in srgb,var(--cdtk-sidebar,var(--color-token-main-surface-primary,light-dark(#ffffff,#10131b))) 90%,light-dark(black,white) 10%)}#codex-usage-toolbar .codex-usage-progress[hidden]{display:none}#codex-usage-toolbar .codex-usage-progress[data-kind=\"usage\"]{top:-3px;--cdt-weekly-progress-color:#3b82f6}#codex-usage-toolbar .codex-usage-progress[data-kind=\"time\"]{bottom:-3px;--cdt-weekly-progress-color:#9ca3af}#codex-usage-toolbar .codex-usage-progress::before{content:\"\";position:absolute;left:0;top:0;width:var(--cdt-weekly-progress-width,0%);height:2px;background:var(--cdt-weekly-progress-color);z-index:2}#codex-usage-toolbar .codex-usage-progress-ticks{position:absolute;left:-1px;right:-1px;top:0;height:2px;z-index:3;background:repeating-linear-gradient(to right,light-dark(rgba(0,0,0,.5),rgba(255,255,255,.5)) 0 2px,transparent 2px calc((100% - 2px)/var(--cdtk-weekly-days)))}#codex-usage-toolbar .codex-usage-progress-morning{position:absolute;top:0;width:2px;height:2px;transform:translateX(-50%);background:#00ff00;z-index:3}";
}
