// Same case-insensitive resolver workaround as bin/peardrop.mjs, for standalone dev scripts.
import path from 'node:path';
import { readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !error.url?.includes('/pearcore/')) throw error;
      const wanted = fileURLToPath(error.url);
      const match = readdirSync(path.dirname(wanted)).find((n) => n.toLowerCase() === path.basename(wanted).toLowerCase());
      if (!match) throw error;
      return next(pathToFileURL(path.join(path.dirname(wanted), match)).href, context);
    }
  },
});
