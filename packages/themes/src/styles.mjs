export function themeChannelColor(channel, color, accent) {
  if (channel === 'accent') return color;
  return `light-dark(color-mix(in srgb,${channel === 'surface' ? accent : color} ${channel === 'surface' ? '30%' : '10%'},white),${color})`;
}

export function themeColorCss() {
  return 'html.cdtk-theme-canvas body{background:var(--cdtk-canvas)!important}'
    + 'html.cdtk-theme-sidebar aside.app-shell-left-panel{background:var(--cdtk-sidebar)!important}'
    + 'html.cdtk-theme-accent aside.app-shell-left-panel{border-color:color-mix(in srgb,var(--cdtk-accent) 30%,transparent)!important}'
    + 'html.cdtk-theme-surface :is(main.main-surface,main[class*="MainContentSurface"],.app-shell-main-content-viewport):not([data-app-shell-tab-panel-controller="right"] *){background:var(--cdtk-surface)!important}'
    + 'html.cdtk-theme-accent aside.app-shell-left-panel [aria-current="page"]{background:light-dark(color-mix(in srgb,var(--cdtk-accent) 40%,white),color-mix(in srgb,var(--cdtk-accent) 24%,transparent))!important;color:light-dark(#1a1c1f,#f7f9fc)!important}'
    + 'html.cdtk-theme-accent aside.app-shell-left-panel [aria-current="page"] :is(span,p,strong){color:inherit!important}'
    + 'html.cdtk-theme-surface main[class*="MainContentSurface"] [class*="MainContentTopFade"]:not([data-app-shell-tab-panel-controller="right"] *){--color-surface:var(--cdtk-surface)!important}'
    + 'html.cdtk-theme-surface main[class*="MainContentSurface"] .thread-scroll-container .pointer-events-none.absolute.inset-x-0.from-surface:not([data-app-shell-tab-panel-controller="right"] *){--tw-gradient-from:var(--cdtk-surface)!important}'
    + 'html.cdtk-theme-surface .thread-scroll-container[data-pip-anchor-host="codex-main-thread"]>[data-thread-scroll-footer="true"]>.pointer-events-none.absolute.bg-surface:not([data-app-shell-tab-panel-controller="right"] *){background-color:var(--cdtk-surface)!important}';
}

export function profilePanelShadowCss() {
  return '[role="menu"][data-radix-menu-content][data-side="right"][data-align="end"].w-57.rounded-2xl{outline:1px solid light-dark(rgba(70,85,110,.3),rgba(220,228,240,.48))!important;outline-offset:0;box-shadow:0 0 18px 3px light-dark(rgba(70,85,110,.12),rgba(220,228,240,.3)),0 12px 36px light-dark(rgba(0,0,0,.18),rgba(0,0,0,.6))!important}';
}

export function themeCss(map, options = {}) {
  return (options.colors === false ? '' : themeColorCss()) + (options.profileShadow === false ? '' : profilePanelShadowCss()) + fontOverrideCss(map.uiFontSizeOverride);
}

export function fontOverrideCss(size, className = 'cdtk-ui-font-override') {
  if (size === null) return '';
  const tokens = { '--text-4xl': 72, '--text-3xl': 48, '--text-2xl': 36, '--text-xl': 28, '--text-lg': 16, '--text-base': 14, '--text-sm': 13, '--text-xs': 12, '--text-heading-lg': 24, '--text-heading-md': 20, '--text-heading-sm': 18 };
  const declarations = [['--vscode-font-size', size], ...Object.entries(tokens).map(([name, value]) => [name, Math.round(value * size / 14)])].map(([name, value]) => name + ':' + value + 'px!important').join(';');
  return 'html.' + className + ',html.' + className + ' body{' + declarations + '}';
}
