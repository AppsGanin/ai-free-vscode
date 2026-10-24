import { setDebugSwitch } from "../src/logger";
import { setHostSettings } from "../src/providers/common/hostSettings";
import { vscodeDebugSwitch, vscodeHostSettings } from "../src/vscode/hostSettings";

// What extension activation installs: settings come from the (mocked) VS Code
// configuration, so tests keep driving them with setSetting().
setDebugSwitch(vscodeDebugSwitch);
setHostSettings(vscodeHostSettings);
