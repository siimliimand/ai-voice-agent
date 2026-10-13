import { fileURLToPath } from "node:url";

/**
 * Absolute path of the public/ assets directory. Works both from source
 * (src/web/**) and from the compiled build (dist/web/**) because both sit
 * two levels below the package root.
 */
export const publicDir = fileURLToPath(new URL("../../public/", import.meta.url));
