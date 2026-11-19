import { createNativeAssetReader, loadNativeConversationRpc, createNativeBridgeClient, acquireFooter, readNativeConversationIdentity, readNativeNotification } from 'codex-toolkit-core/renderer';
import * as timer from './composer-timer.mjs';
import * as context from './context-usage.mjs';
import * as speed from './output-speed.mjs';
import * as client from './native-client.mjs';
import * as usage from './native-usage.mjs';
import * as labels from './message-labels.mjs';
import * as history from './turn-history.mjs';
import * as output from './live-output.mjs';
import { weeklyProgress } from './weekly-progress.mjs';
import { installUsageToolbar } from './toolbar.mjs';
import { installContextUi } from './context-ui.mjs';
import { installComposerUi } from './composer-ui.mjs';
import { installSpeedUi } from './speed-ui.mjs';
import { installFileLineHighlight } from './file-line-highlight.mjs';
import { chatCss, weeklyUsageCss, tableStyleCss, imageViewerCloseCss, selectionActionsCss, contextUsageCss, contextUsageTicksCss, speedHistoryCss, modelDecorationsCss, composerTimerCss, liveOutputCss, messageLabelsCss, historyControlCss } from './styles.mjs';
import { installChatRenderer } from './renderer.mjs';
import * as decorations from './model-decorations.mjs';
import { installSelectionActions } from './selection-actions.mjs';
import { sanitizeRichPaste, installRichPaste } from './rich-paste.mjs';
import { hardResetRange } from './hard-reset.mjs';
import { installScrollHandoffRepair, scrollHandoffCorrection } from './scroll-handoff.mjs';
import { installScrollDiagnostics } from './scroll-diagnostics.mjs';

export function chatPayload(state) {
  const helpers = { createNativeAssetReader, loadNativeConversationRpc, createNativeBridgeClient, acquireFooter, readNativeConversationIdentity, readNativeNotification, ...timer, ...context, ...speed, ...client, ...usage, ...labels, ...history, ...output, ...decorations,
    weeklyProgress, installUsageToolbar, installContextUi, installComposerUi, installSpeedUi, installFileLineHighlight, installSelectionActions, sanitizeRichPaste, installRichPaste, hardResetRange, chatCss, weeklyUsageCss, tableStyleCss, imageViewerCloseCss, selectionActionsCss, contextUsageCss, contextUsageTicksCss, speedHistoryCss, modelDecorationsCss, composerTimerCss, liveOutputCss, messageLabelsCss, historyControlCss,
    installScrollHandoffRepair, scrollHandoffCorrection, installScrollDiagnostics };
  const declarations = Object.entries(helpers).map(([name, fn]) => 'const ' + name + '= (' + fn.toString() + ');').join('\n');
  return '(()=>{\n' + declarations + '\nreturn (' + installChatRenderer.toString() + ')(window,' + JSON.stringify(state) + ',{' + Object.keys(helpers).join(',') + '});\n})()\n//# sourceURL=codex-desktop-toolkit-chat.js';
}
