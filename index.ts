import dotenv from "dotenv";
import { WebClient } from "@slack/web-api";
import { RTMClient } from "@slack/rtm-api";
import * as docker from "./docker";

dotenv.config();

const token = process.env.SLACK_TOKEN ?? "";

const slack = new WebClient(token);
const rtm = new RTMClient(token);

const main = async () => {
  rtm.on("message", async (message: any) => {
    const m = /^@golfbot\s+check\s+(?<lang>\w+)\s/i.exec(message.text);
    if (!m) return;
    const lang = (m.groups as any)["lang"];

    const args = {
      lang,
      code: "",
      input: "",
    } as any;
    let key = "code";
    for (const element of message["blocks"][0]["elements"]) {
      if (element["type"] === "rich_text_section") {
        const text = element?.["elements"]?.[0]?.["text"] as string;
        const m = /^\s*(?<key>code|input)\s*$/i.exec(text);
        if (m) {
          key = (m.groups as any)["key"];
        }
      }
      if (element.type === "rich_text_preformatted") {
        const text = element?.["elements"]?.[0]?.["text"];
        if (text) {
          args[key] = text;
        }
      }
    }

    console.log(args);

    await docker
      .run({
        lang: args.lang,
        code: Buffer.from(args.code),
        stdin: Buffer.from(args.input),
      })
      .then(async (res) => {
        console.log(res);
        await slack.chat.postMessage({
          channel: message.channel,
          text: `\
output
\`\`\`
${res.stdout.toString()}
\`\`\`
debug
\`\`\`
${res.stderr.toString()}
\`\`\`
`,
          thread_ts: message.ts,
          reply_broadcast: true,
        });
      })
      .catch(async (err) => {
        console.log(err);
        await slack.chat.postMessage({
          channel: message.channel,
          text: `\
${err.toString()}
`,
          thread_ts: message.ts,
          reply_broadcast: true,
        });
      });
  });

  await rtm.start();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
