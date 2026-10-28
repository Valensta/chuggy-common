/**
 * The chat protocol held against its version. A host and its supervisor come
 * from cores released apart, so everything one hands the other is the
 * protocol, as `./chatSupervisor.mjs` says: this suite names the shape of all
 * of it beside `chatProtocolVersion`, and fails where one changes without the
 * other.
 *
 * Each side refuses the other across a bump. A supervisor told a protocol it
 * does not speak exits saying so before it reads any setting
 * (`./chatSupervisor.test.mjs`); a host whose supervisor's `Ready` lacks its
 * own version ends and kills it before claiming a session for it
 * (`./chatHostBackend.test.mjs`), which is what a host a version ahead of
 * its image meets.
 *
 * THE SHAPE IS NAMES AND MOUNTS, NOT WHAT A VALUE MEANS. A value's form or
 * meaning changing under a name it already holds — the JSON in
 * `CHUG_WORKER_CLAUDE_CREDENTIAL`, or what `CHUG_CHAT_CREDENTIAL_UID` is the
 * uid of — passes here, and still bumps the version, by hand.
 *
 * `chatProtocolVersion` is chuggy's, in `@chuggy/worker-contract`: a bump is a
 * contract release, then this core's lock moved to it. The window it opens
 * ends as `./chatSupervisor.mjs` says.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  chatProtocolSpoken,
  chatProtocolVersion,
} from "@chuggy/worker-contract/chatHost";

import { chatSupervisorCommand, chatSupervisorContainer } from "./chatHost.mjs";
import {
  chatSupervisorProtocolVariable,
  chatSupervisorProtocols,
  chatSupervisorVariables,
} from "./chatSupervisor.mjs";

/**
 * The shape this suite last saw, and the protocol it was. A change to the
 * shape bumps `chatProtocolVersion`, and `chatSupervisorProtocols` keeps the
 * version before it, its supervisor reading the old shape too, for one
 * release window; then this is written again under the new version.
 */
const recorded = {
  protocol: 1,
  shape: {
    variables: [
      "CHUG_CHAT_CREDENTIAL",
      "CHUG_CHAT_CREDENTIAL_GID",
      "CHUG_CHAT_CREDENTIAL_UID",
      "CHUG_CHAT_MINTED",
      "CHUG_CHAT_MIRRORS",
      "CHUG_CHAT_MIRROR_GROUP_COUNT",
      "CHUG_CHAT_MIRROR_GROUP_FIRST",
      "CHUG_CHAT_PROTOCOL",
      "CHUG_CHAT_SESSIONS",
      "CHUG_CHAT_SESSIONS_MAX",
      "CHUG_CHAT_SUPERVISOR_MINTED",
      "CHUG_CHAT_UID_COUNT",
      "CHUG_CHAT_UID_FIRST",
      "CHUG_WORKER_CLAUDE_CREDENTIAL",
      "CHUG_WORKER_REPOSITORIES",
    ],
    command: [
      "/opt/chuggy/bin/tini",
      "-s",
      "--",
      "/opt/chuggy/bin/node",
      "/opt/chuggy/lib/chuggy/chatSupervisor.mjs",
    ],
    user: "0:0",
    capabilities: {
      drop: ["ALL"],
      add: [
        "CHOWN",
        "DAC_OVERRIDE",
        "FOWNER",
        "FSETID",
        "SETUID",
        "SETGID",
        "SETPCAP",
      ],
    },
    securityOptions: ["no-new-privileges"],
    interactive: true,
    tmpfs: [
      {
        target: "/var/run/chuggy",
        mode: "711",
        owner: "root",
        flags: ["nosuid", "nodev", "noexec"],
      },
      {
        target: "/var/run/chuggy/credentials",
        mode: "700",
        owner: "credentialOwner",
        flags: ["nosuid", "nodev", "noexec"],
      },
    ],
    binds: [{ target: "/var/run/chuggy/credentials/provider", readonly: true }],
    volumeTargets: ["/sessions", "/var/lib/chuggy/mirrors"],
  },
};

/** What a host hands this core's supervisor, given all it can be given. */
function shapeNow() {
  const credentialOwner = { uid: 501, gid: 20 };
  const container = chatSupervisorContainer(
    "registry.example/chat",
    {
      volumes: { sessions: "s", mirrors: "m" },
      credentialFile: "/home/geoff/.chuggy/claude/claude.json",
      credentialOwner,
      claudeCredential: { kind: "Subscription" },
      repositories: "{}",
    },
    2 ** 30,
  );
  /** @param {{uid: number, gid: number}} owner who it is to the supervisor, not which uid */
  const role = ({ uid, gid }) =>
    uid === 0 && gid === 0
      ? "root"
      : uid === credentialOwner.uid && gid === credentialOwner.gid
        ? "credentialOwner"
        : `${String(uid)}:${String(gid)}`;
  return {
    variables: [
      ...new Set([
        chatSupervisorProtocolVariable,
        ...Object.values(chatSupervisorVariables),
        ...Object.keys(container.environment),
      ]),
    ].sort(),
    command: [...chatSupervisorCommand],
    user: container.user,
    capabilities: {
      drop: [...container.capabilities.drop],
      add: [...container.capabilities.add],
    },
    securityOptions: [...container.securityOptions],
    interactive: container.interactive,
    tmpfs: container.tmpfs.map((tmpfs) => ({
      target: tmpfs.target,
      mode: tmpfs.mode.toString(8),
      owner: role(tmpfs),
      flags: [...tmpfs.flags],
    })),
    binds: container.binds.map(({ target, readonly }) => ({
      target,
      readonly,
    })),
    volumeTargets: container.volumes.map(({ target }) => target),
  };
}

test("what a host hands its supervisor is the shape recorded for this protocol", () => {
  assert.equal(
    chatProtocolVersion,
    recorded.protocol,
    `chatProtocolVersion is ${String(chatProtocolVersion)} and the shape here was recorded under ${String(recorded.protocol)}: keep the old shape in chatSupervisorProtocols for one release window, then record the shape again under the new version`,
  );
  assert.deepEqual(
    shapeNow(),
    recorded.shape,
    `what a host hands its supervisor changed under protocol ${String(chatProtocolVersion)}: bump chatProtocolVersion, keep the old shape for one release window (chatSupervisorProtocols names both, and the supervisor reads either), then record the shape again here`,
  );
});

test("a supervisor speaks the version its host speaks, and a host refuses one that speaks only the version before", () => {
  assert.ok(chatSupervisorProtocols.includes(chatProtocolVersion));
  assert.equal(
    chatProtocolSpoken({
      frame: "Ready",
      protocols: [chatProtocolVersion - 1],
      sessionsMax: 1,
      contractRelease: "1.0.0",
    }),
    false,
  );
});
