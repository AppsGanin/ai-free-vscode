import { profileDir } from "../common/browserAuth";

export const HOME_URL = "https://chat.z.ai";

/**
 * One profile for sign-in and the bridge: the bridge sends messages as the
 * account that signed in there. Chrome locks a profile to one process, so the
 * two never run at the same time — the provider closes the bridge first.
 */
export const browserDataDir = (): string => profileDir("zai-browser-profile");
