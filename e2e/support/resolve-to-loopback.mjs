// Preloaded into a server under test (`NODE_OPTIONS=--import=<this file>`):
// every host name the image proxy looks up resolves to 127.0.0.1, as a
// sender's DNS could arrange. The suite can then watch the built server
// refuse the address, without a real DNS query leaving the machine.
//
// Only `dns.promises.lookup` is replaced, which the image proxy uses. The
// server's connection to Stalwart resolves through `dns.lookup` and is not
// affected.

import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";

const LOOPBACK = { address: "127.0.0.1", family: 4 };

dns.promises.lookup = (_hostname, options) =>
	Promise.resolve(
		typeof options === "object" && options?.all ? [LOOPBACK] : LOOPBACK
	);
syncBuiltinESMExports();
