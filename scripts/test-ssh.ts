import { Client } from "ssh2";

const SSH_CONFIG = {
	host: process.env.SSH_HOST || "192.168.2.11",
	port: Number(process.env.SSH_PORT) || 22,
	username: process.env.SSH_USER || "root",
	password: process.env.SSH_PASSWORD,
};

const nasMailsDir = process.env.NAS_MAILS_DIR || "/mnt/user/backups/mails";
const cmd = `find ${nasMailsDir}/ -name "*.eml" -type f | xargs grep -l -i "jlcpcb" | xargs grep -l -i -E "order|shipped|shipment|tracking" | head -n 20`;

const conn = new Client();
conn.on("ready", () => {
	console.log("Connected. Running search...");
	conn.exec(cmd, (err, stream) => {
		if (err) {
			console.error(err);
			conn.end();
			return;
		}
		let stdout = "";
		stream.on("data", (data: any) => {
			stdout += data.toString();
		});
		stream.on("close", () => {
			conn.end();
			console.log("Matching files:\n", stdout);
		});
	});
}).connect(SSH_CONFIG);
