import path from "path";
import fs from "fs/promises";
import stream from "stream";
import tmp from "tmp-promise";
import Docker from "dockerode";
import type DockerModem from "docker-modem";
import languages from "./data/languages.json";

const docker = new Docker();

class TimeLimitExceededError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "TimeLimitExceededError";
  }
}

class MemoryLimitExceededError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "MemoryLimitExceededError";
  }
}

type RunOptions = {
  lang: keyof typeof languages;
  code: Buffer;
  stdin: Buffer;
};

type RunResult = {
  stdout: Buffer;
  stderr: Buffer;
};

export const run = async ({
  lang,
  code,
  stdin,
}: RunOptions): Promise<RunResult> => {
  const langInfo = languages[lang];

  const tmpDir = await tmp.dir({ unsafeCleanup: true });

  const codePath = path.join(tmpDir.path, langInfo.fileName);

  await fs.writeFile(codePath, code);

  const stdoutChunks: Buffer[] = [];
  const stdoutStream = new stream.Writable({
    write(chunk: Buffer, _encoding, next) {
      stdoutChunks.push(chunk);
      next();
    },
  });

  const stderrChunks: Buffer[] = [];
  const stderrStream = new stream.Writable({
    write(chunk: Buffer, _encoding, next) {
      stderrChunks.push(chunk);
      next();
    },
  });

  const trace = false;
  const disasm = false;

  const container = await docker.createContainer({
    Hostname: "",
    User: "",
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: true,
    StdinOnce: true,
    Env: trace ? ["STRACE_OUTPUT_PATH=/volume/strace.log"] : [],
    Cmd: ["script", ...(disasm ? ["-d"] : []), `/volume/${langInfo.fileName}`],
    Image: langInfo.image,
    Volumes: {
      "/volume": {},
    },
    HostConfig: {
      Binds: [`${tmpDir.path}:/volume:${trace ? "rw" : "ro"}`],
      Memory: langInfo.memoryLimit * 1000 * 1000,
      ...(trace ? { CapAdd: ["SYS_PTRACE"] } : {}),
    },
    NetworkDisabled: true,
  });

  const timeout = 3 * 1000;

  await Promise.race([
    new Promise((_resolve, reject) => {
      setTimeout(() => {
        reject(new TimeLimitExceededError());
      }, timeout);
    }),
    (async () => {
      const stream = await container.attach({
        stream: true,
        hijack: true,
        stdin: true,
        stdout: true,
        stderr: true,
      });
      (container.modem as DockerModem).demuxStream(
        stream,
        stdoutStream,
        stderrStream
      );
      stream.on("end", () => {
        stdoutStream.end();
        stderrStream.end();
      });
      await container.start();
      stream.end(stdin);
      await container.wait();
      const inspectInfo = await container.inspect();
      await container.remove();
      return inspectInfo;
    })(),
  ]).catch(async (error) => {
    await container.kill();
    await container.remove();
    throw error;
  });

  await tmpDir.cleanup();

  return {
    stdout: Buffer.concat(stdoutChunks),
    stderr: Buffer.concat(stderrChunks),
  };
};
