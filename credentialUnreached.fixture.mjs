/**
 * The ways the plane's app does not reach a repository, as the credential
 * routes answer them, each with every phrase a person reading the refusal is
 * told: the repository, the app, the installation where there is one, and the
 * contract's remedy for that case.
 */

const repository = "https://github.com/kasofsk/chuggy-common.git";

export const credentialUnreachedCases = [
  {
    unreached: {
      reach: "Unselected",
      repository,
      app: "worker",
      installation: "91234567",
    },
    told: [
      repository,
      "the worker app's installation 91234567",
      "does not select it",
      "add it to that installation's repository selection",
    ],
  },
  {
    unreached: {
      reach: "Refused",
      repository,
      app: "worker",
      installation: "91234567",
    },
    told: [
      repository,
      "the forge refused the worker app's installation 91234567",
      "for its key, a suspension or a permission not accepted",
      "go to the worker app's installation page",
    ],
  },
  {
    unreached: { reach: "Unclaimed", repository, app: "worker" },
    told: [
      repository,
      "no installation of the worker app is claimed on its owner",
      "install the worker app there",
    ],
  },
];

/** What the mounted map refuses a repository it carries no row for with. */
export const credentialUnmappedText = /no repository configuration for/u;

/** A repository map that fails the case where anything reads it. */
export const credentialUnreadMap = new Proxy(
  {},
  {
    get: () => credentialUnreadMapRead("get"),
    has: () => credentialUnreadMapRead("has"),
    getOwnPropertyDescriptor: () =>
      credentialUnreadMapRead("getOwnPropertyDescriptor"),
    ownKeys: () => credentialUnreadMapRead("ownKeys"),
  },
);

function credentialUnreadMapRead(trap) {
  throw new Error(`the mounted repository map was read (${trap})`);
}
