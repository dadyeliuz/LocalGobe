import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createRegisteredAccount,
  getAccount,
  hasAccount,
  verifyAccountCredentials,
} from "../src/storage/accounts-store.ts";
import {
  buildLoginUResponse,
  digest,
  parseLoginURequest,
} from "../src/server/http/login-u.ts";
import { handleGameRoute } from "../src/server/http/game-routes.ts";
import { ServerState } from "../src/server/smartfox/server-state.ts";

function makeLoginUPayload(params: Record<string, string>): { rawUrl: string; requestBody: string } {
  const innerQs = new URLSearchParams(params).toString();
  const mog = Buffer.from(innerQs, "utf8").toString("base64");
  const md = digest(mog);
  const requestBody = new URLSearchParams({ mog, md }).toString();
  return {
    rawUrl: "/servises/loginu.aspx",
    requestBody,
  };
}

function decodeInnerXml(body: string): string {
  const match = body.match(/<mog>([\s\S]*?)<\/mog>/);
  if (!match) throw new Error("No mog tag found");
  return Buffer.from(match[1], "base64").toString("utf8");
}

test("Registration VName contract validates availability, rejection, and suggestion shape", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-reg-test-"));
  try {
    // 1. Seed existing user
    createRegisteredAccount("existingPlayer", "alphaSecret1", 4, "existing@test.local", dataDir);
    assert.equal(hasAccount("existingPlayer", dataDir), true);

    // 2. VName for a valid, available new username
    const validReq = makeLoginUPayload({
      cmd: "VName",
      t: "0.12345",
      newUserName: "newMogobeKid",
      newPass: "safeSecret1",
      userId: "-1",
      userName: "",
    });
    const parsedValid = parseLoginURequest(validReq.rawUrl, validReq.requestBody);
    assert.ok(parsedValid);
    assert.equal(parsedValid.command, "VName");

    const validXml = buildLoginUResponse(parsedValid, "http://127.0.0.1:5173", dataDir);
    const innerValid = decodeInnerXml(validXml);
    assert.ok(innerValid.includes('err="-1"'));
    assert.ok(innerValid.includes('userName="newMogobeKid"'));
    const matchUserId = innerValid.match(/userId="(\d+)"/);
    assert.ok(matchUserId && Number(matchUserId[1]) > 0);

    // 3. VName for duplicate username returns err="2" with suggestions
    const dupReq = makeLoginUPayload({
      cmd: "VName",
      t: "0.54321",
      newUserName: "existingPlayer",
      newPass: "safeSecret1",
      userId: "-1",
      userName: "",
    });
    const parsedDup = parseLoginURequest(dupReq.rawUrl, dupReq.requestBody);
    assert.ok(parsedDup);
    const dupXml = buildLoginUResponse(parsedDup, "http://127.0.0.1:5173", dataDir);
    const innerDup = decodeInnerXml(dupXml);
    assert.ok(innerDup.includes('err="2"'));
    assert.ok(innerDup.includes("<Avilable>"));
    assert.ok(innerDup.includes("<name>existingPlayer1</name>"));

    // 4. VName for invalid username (< 4 chars or non-alphanumeric) returns err="1"
    const shortReq = makeLoginUPayload({
      cmd: "VName",
      t: "0.999",
      newUserName: "ab",
      newPass: "safeSecret1",
      userId: "-1",
      userName: "",
    });
    const parsedShort = parseLoginURequest(shortReq.rawUrl, shortReq.requestBody);
    assert.ok(parsedShort);
    const shortXml = buildLoginUResponse(parsedShort, "http://127.0.0.1:5173", dataDir);
    assert.ok(decodeInnerXml(shortXml).includes('err="1"'));

    const symbolReq = makeLoginUPayload({
      cmd: "VName",
      t: "0.888",
      newUserName: "bad kid!",
      newPass: "safeSecret1",
      userId: "-1",
      userName: "",
    });
    const parsedSymbol = parseLoginURequest(symbolReq.rawUrl, symbolReq.requestBody);
    assert.ok(parsedSymbol);
    const symbolXml = buildLoginUResponse(parsedSymbol, "http://127.0.0.1:5173", dataDir);
    assert.ok(decodeInnerXml(symbolXml).includes('err="1"'));

    // 5. VName for invalid password (< 4 chars or equals username) returns err="3"
    const samePassReq = makeLoginUPayload({
      cmd: "VName",
      t: "0.777",
      newUserName: "sampleName",
      newPass: "sampleName",
      userId: "-1",
      userName: "",
    });
    const parsedSame = parseLoginURequest(samePassReq.rawUrl, samePassReq.requestBody);
    assert.ok(parsedSame);
    const sameXml = buildLoginUResponse(parsedSame, "http://127.0.0.1:5173", dataDir);
    assert.ok(decodeInnerXml(sameXml).includes('err="3"'));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Registration VMail and Regist contracts create account and reject duplicate overwrite", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-reg2-test-"));
  const activeBuildId = "20160725-android-1.4.7";
  try {
    // 1. VMail valid
    const mailValidReq = makeLoginUPayload({
      cmd: "VMail",
      t: "0.333",
      email: "player@localgobe.net",
      userName: "registeredPlayer",
      userId: "12345",
    });
    const gameRouteMailRes = handleGameRoute({
      rawUrl: mailValidReq.rawUrl,
      pathname: mailValidReq.rawUrl,
      requestBody: mailValidReq.requestBody,
      origin: "http://127.0.0.1:5173",
      buildId: activeBuildId,
      dataDir,
    });
    assert.equal(gameRouteMailRes?.status, 200);
    assert.ok(decodeInnerXml(String(gameRouteMailRes?.body)).includes('err="-1"'));

    // 2. VMail invalid
    const mailInvalidReq = makeLoginUPayload({
      cmd: "VMail",
      t: "0.334",
      email: "not-an-email",
      userName: "registeredPlayer",
      userId: "12345",
    });
    const gameRouteInvalidMail = handleGameRoute({
      rawUrl: mailInvalidReq.rawUrl,
      pathname: mailInvalidReq.rawUrl,
      requestBody: mailInvalidReq.requestBody,
      origin: "http://127.0.0.1:5173",
      buildId: activeBuildId,
      dataDir,
    });
    assert.equal(gameRouteInvalidMail?.status, 200);
    assert.ok(decodeInnerXml(String(gameRouteInvalidMail?.body)).includes('err="7"'));

    // 3. Regist creates new account with chosen color (e.g. 7)
    const registReq = makeLoginUPayload({
      cmd: "Regist",
      t: "0.444",
      userName: "registeredPlayer",
      password: "secretPassword99",
      email: "player@localgobe.net",
      age: "9",
      isChatOpen: "true",
      color: "7",
      agree: "true",
      agreeMail: "true",
      userId: "12345",
    });
    const registRes = handleGameRoute({
      rawUrl: registReq.rawUrl,
      pathname: registReq.rawUrl,
      requestBody: registReq.requestBody,
      origin: "http://127.0.0.1:5173",
      buildId: activeBuildId,
      dataDir,
    });
    assert.equal(registRes?.status, 200);
    assert.ok(decodeInnerXml(String(registRes?.body)).includes('err="-1"'));

    // Verify persisted account
    const acc = getAccount("registeredPlayer", dataDir);
    assert.ok(acc);
    assert.equal(acc.username, "registeredPlayer");
    assert.equal(acc.color, 7);
    assert.equal(acc.coins, 500);
    assert.equal(acc.email, "player@localgobe.net");
    assert.equal(verifyAccountCredentials("registeredPlayer", "secretPassword99", dataDir), true);
    assert.equal(verifyAccountCredentials("registeredPlayer", "wrongPassword", dataDir), false);

    // 4. Duplicate Regist attempt must fail with err="2" and NOT overwrite existing account
    const dupRegistReq = makeLoginUPayload({
      cmd: "Regist",
      t: "0.555",
      userName: "registeredPlayer",
      password: "anotherPassword99",
      email: "intruder@fake.net",
      age: "12",
      isChatOpen: "false",
      color: "2",
      agree: "true",
      agreeMail: "true",
      userId: "99999",
    });
    const dupRegistRes = handleGameRoute({
      rawUrl: dupRegistReq.rawUrl,
      pathname: dupRegistReq.rawUrl,
      requestBody: dupRegistReq.requestBody,
      origin: "http://127.0.0.1:5173",
      buildId: activeBuildId,
      dataDir,
    });
    assert.equal(dupRegistRes?.status, 200);
    assert.ok(decodeInnerXml(String(dupRegistRes?.body)).includes('err="2"'));

    // Confirm original account was untouched
    const accAfter = getAccount("registeredPlayer", dataDir);
    assert.ok(accAfter);
    assert.equal(accAfter.color, 7);
    assert.equal(accAfter.email, "player@localgobe.net");
    assert.equal(verifyAccountCredentials("registeredPlayer", "secretPassword99", dataDir), true);
    assert.equal(verifyAccountCredentials("registeredPlayer", "anotherPassword99", dataDir), false);

    // 5. Post-registration login works via /servises/loginu.aspx
    const loginReq = makeLoginUPayload({
      cmd: "Login",
      t: "0.666",
      name: "registeredPlayer",
      pass: "secretPassword99",
    });
    const loginRes = handleGameRoute({
      rawUrl: loginReq.rawUrl,
      pathname: loginReq.rawUrl,
      requestBody: loginReq.requestBody,
      origin: "http://127.0.0.1:5173",
      buildId: activeBuildId,
      dataDir,
    });
    assert.equal(loginRes?.status, 200);
    assert.ok(decodeInnerXml(String(loginRes?.body)).includes('status="1"'));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("SmartFox hydrates registered avatar color and isolates transient room uVars updates", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-sfs-reg-test-"));
  try {
    // 1. Create registered account with color 9
    createRegisteredAccount("colorHero", "safeSecretPass", 9, undefined, dataDir);

    // 2. Initialize SmartFox session and login
    const state = new ServerState(undefined, undefined, dataDir);
    const mockSocket = {} as any;
    const session = state.createSession(mockSocket);

    const acc = getAccount("colorHero", dataDir);
    assert.ok(acc);
    assert.equal(acc.color, 9);

    const loginRes = state.handleLogin(session, "colorHero", acc.color, {
      coins: acc.coins,
      inventory: acc.inventory,
      hasPersistentAccount: true,
    });
    assert.equal(loginRes.userName, "colorHero");
    assert.equal(session.color, 9);
    assert.equal(session.playerData.color, 9);

    // 3. Transient in-room color change (e.g. minigame paint)
    state.updateUserVariables(session, { color: 4 });
    // In-room session user variable reflects 4
    assert.equal(session.color, 4);
    // But persistent player data color remains 9
    assert.equal(session.playerData.color, 9);

    // 4. Persistence call maintains registered color 9
    state.persistPlayerState(session);
    const reloadedAcc = getAccount("colorHero", dataDir);
    assert.ok(reloadedAcc);
    assert.equal(reloadedAcc.color, 9);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
