import { syncAccount } from './syncAccount.js';

export default {
	async scheduled(_event, env, _ctx): Promise<void> {
		await syncAccount(env);
	},
} satisfies ExportedHandler<Env>;
