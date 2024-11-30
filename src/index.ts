import dotenv from 'dotenv';
import toml from 'toml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { syncAccount } from './syncAccount.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({
	path: path.join(__dirname, '../.dev.vars'),
});

const env: Env = {
	...process.env,
	...toml.parse(fs.readFileSync(path.join(__dirname, '../wrangler.toml'), 'utf8')).vars,
};

try {
	await syncAccount(env);
	process.exit();
} catch (e) {
	console.error(e);
	process.exit(1);
}
