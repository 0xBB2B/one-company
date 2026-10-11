import { installProduct } from "../acceptance/helpers/installed-host.ts";

process.stdout.write(await installProduct(process.argv[2]!));
