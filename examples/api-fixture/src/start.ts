// `pnpm --filter api-fixture start` runs the fixture until you stop it.
import { startFixtureApi } from './index.js';

const api = await startFixtureApi({ port: Number(process.env.PORT ?? 3400) });
process.stdout.write(`${api.url}\n`);
