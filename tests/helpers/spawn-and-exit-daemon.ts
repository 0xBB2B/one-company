import { connectDaemon } from "../../runtime/daemon-client.ts";
import type { ConnectDaemonOptions } from "../../runtime/daemon-client.ts";

const options = JSON.parse(process.argv[2] as string) as ConnectDaemonOptions;
const client = await connectDaemon(options);
await client.call("ping", {});
process.exit(0);
