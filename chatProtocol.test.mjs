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
    credentialTarget: "/var/run/chuggy/credentials/provider",
    tmpfsTargets: ["/var/run/chuggy", "/var/run/chuggy/credentials"],
    volumeTargets: ["/sessions", "/var/lib/chuggy/mirrors"],
  },
};

/** What a host hands this core's supervisor, given all it can be given. */
function shapeNow() {
  const container = chatSupervisorContainer(
    "registry.example/chat",
    {
      volumes: { sessions: "s", mirrors: "m" },
      credentialFile: "/home/geoff/.chuggy/claude/claude.json",
      credentialOwner: { uid: 501, gid: 20 },
      claudeCredential: { kind: "Subscription" },
      repositories: "{}",
    },
    2 ** 30,
  );
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
    credentialTarget: container.binds.map(({ target }) => target).join(),
    tmpfsTargets: container.tmpfs.map(({ target }) => target),
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
