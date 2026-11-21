import { createHash } from "node:crypto";
import {
  createOrEnsureAccount,
  createRegisteredAccount,
  generateAvailableUsernames,
  hasAccount,
  verifyAccountCredentials,
} from "../../storage/accounts-store.ts";

export const LOCAL_SERVER = Object.freeze({
  name: "LocalGobe",
  ip: "127.0.0.1",
  port: 8001,
  webPort: 0,
});

export type LoginUCommand = {
  command: "Login" | "Servers" | "WorldInfo" | "VName" | "VMail" | "Regist" | "SetMobileToken";
  token: string;
  user: string;
  password: string;
  appVer?: string;
  brand?: string;
  model?: string;
  serialNumber?: string;
  newUserName?: string;
  newPass?: string;
  userId?: number;
  email?: string;
  age?: number;
  isChatOpen?: boolean;
  color?: number;
  agree?: boolean;
  agreeMail?: boolean;
  os?: string;
};

export function digest(encoded: string): string {
  return createHash("md5")
    .update(`1qscvhui9mogo123${encoded}123mogo1qscvhui9`, "utf8")
    .digest("hex");
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[char]!);
}

export function parseLoginURequest(rawUrl: string, requestBody?: string): LoginUCommand | null {
  const url = new URL(rawUrl, "http://127.0.0.1");
  if (url.pathname.toLowerCase() !== "/servises/loginu.aspx") return null;
  const bodyParams = requestBody ? new URLSearchParams(requestBody) : null;
  const encoded = url.searchParams.get("mog") ?? bodyParams?.get("mog");
  const md = url.searchParams.get("md") ?? bodyParams?.get("md");
  const compact = encoded?.replace(/\r?\n/g, "");
  if (
    !encoded ||
    !md ||
    !compact ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) ||
    md.toLowerCase() !== digest(encoded)
  ) {
    return null;
  }
  const body = new URLSearchParams(Buffer.from(compact, "base64").toString("utf8"));
  const command = body.get("cmd");
  const token = body.get("t");
  if (!command || !token) return null;

  const validCommands = new Set(["Login", "Servers", "WorldInfo", "VName", "VMail", "Regist", "SetMobileToken"]);
  if (!validCommands.has(command)) return null;

  const user = body.get("name") ?? body.get("userName") ?? body.get("newUserName") ?? "";
  const password = body.get("pass") ?? body.get("password") ?? body.get("newPass") ?? "";

  const res: LoginUCommand = {
    command: command as LoginUCommand["command"],
    token,
    user,
    password,
  };

  const appVer = body.get("appVer");
  if (appVer !== null) res.appVer = appVer;
  const brand = body.get("brand");
  if (brand !== null) res.brand = brand;
  const model = body.get("model");
  if (model !== null) res.model = model;
  const serialNumber = body.get("serialNumber");
  if (serialNumber !== null) res.serialNumber = serialNumber;

  const newUserName = body.get("newUserName");
  if (newUserName !== null) res.newUserName = newUserName;
  const newPass = body.get("newPass");
  if (newPass !== null) res.newPass = newPass;

  const userIdStr = body.get("userId");
  if (userIdStr !== null && !isNaN(Number(userIdStr))) res.userId = Number(userIdStr);

  const email = body.get("email");
  if (email !== null) res.email = email;

  const ageStr = body.get("age");
  if (ageStr !== null && !isNaN(Number(ageStr))) res.age = Number(ageStr);

  const isChatOpenStr = body.get("isChatOpen");
  if (isChatOpenStr !== null) res.isChatOpen = isChatOpenStr.toLowerCase() === "true";

  const colorStr = body.get("color");
  if (colorStr !== null && !isNaN(Number(colorStr))) res.color = Number(colorStr);

  const agreeStr = body.get("agree");
  if (agreeStr !== null) res.agree = agreeStr.toLowerCase() === "true";

  const agreeMailStr = body.get("agreeMail");
  if (agreeMailStr !== null) res.agreeMail = agreeMailStr.toLowerCase() === "true";

  const os = body.get("os");
  if (os !== null) res.os = os;

  return res;
}

/**
 * Authenticates against local user-data accounts. For a fresh local-only copy
 * with no pre-seeded accounts, a first-time login creates the local player account
 * automatically so the user can enter the world immediately.
 */
export function authenticateLocalUser(command: LoginUCommand, dataDir?: string): boolean {
  if (command.command === "WorldInfo") return true;
  if (!command.user.trim()) return false;
  if (hasAccount(command.user, dataDir)) {
    return verifyAccountCredentials(command.user, command.password, dataDir);
  }
  createOrEnsureAccount(command.user, command.password, 0, dataDir);
  return true;
}

export function buildLoginUResponse(
  command: LoginUCommand,
  origin = "http://127.0.0.1:5173",
  dataDir?: string,
  authenticated = true,
): string {
  const cleanOrigin = origin.replace(/\/+$/, "");

  let body = "";

  switch (command.command) {
    case "WorldInfo": {
      body = `<World allow="true" appVer="${escapeXml(command.appVer ?? "1.0.0")}" mUrl="${escapeXml(cleanOrigin)}" md="${escapeXml(cleanOrigin)}" lang="1" award="-1" debug="false" adv="" atc="" arg="true" ram="false" FileRequestHelperEncryptKey="" />`;
      break;
    }

    case "Login": {
      if (authenticated) {
        body = '<Login status="1" allow="false" isMember="false"><FirstLoadingScreens><Screen i="1" t="2"/></FirstLoadingScreens></Login>';
      } else {
        body = '<Login status="2" allow="false" isMember="false"/>';
      }
      break;
    }

    case "Servers": {
      body = `<Servers><Server id="1" name="${LOCAL_SERVER.name}" ip="${LOCAL_SERVER.ip}" port="${LOCAL_SERVER.port}" webPort="${LOCAL_SERVER.webPort}" status="1" percentage="20" chatMode="true" friends="0"/></Servers>`;
      break;
    }

    case "VName": {
      const targetUser = command.newUserName ?? command.user ?? "";
      const targetPass = command.newPass ?? command.password ?? "";

      // Validate username rules: 4-16 alphanumeric characters, no spaces, no symbols
      if (!targetUser || targetUser.length < 4 || targetUser.length > 16 || !/^[a-zA-Z0-9]+$/.test(targetUser)) {
        body = `<Validate err="1" userName="${escapeXml(targetUser)}" pass="${escapeXml(targetPass)}" userId="-1"><Avilable/></Validate>`;
      } else if (!targetPass || targetPass.length < 4 || targetPass.length > 32 || targetUser.toLowerCase() === targetPass.toLowerCase()) {
        body = `<Validate err="3" userName="${escapeXml(targetUser)}" pass="${escapeXml(targetPass)}" userId="-1"><Avilable/></Validate>`;
      } else if (hasAccount(targetUser, dataDir)) {
        const suggestions = generateAvailableUsernames(targetUser, 3, dataDir);
        const availXml = suggestions.map((s) => `<name>${escapeXml(s)}</name>`).join("");
        body = `<Validate err="2" userName="${escapeXml(targetUser)}" pass="${escapeXml(targetPass)}" userId="-1"><Avilable>${availXml}</Avilable></Validate>`;
      } else {
        // Valid & available: assign a non-zero positive user ID
        const hashNum = Math.abs(createHash("md5").update(targetUser).digest().readInt32LE(0));
        const assignedId = (hashNum % 900000) + 100000;
        body = `<Validate err="-1" userName="${escapeXml(targetUser)}" pass="${escapeXml(targetPass)}" userId="${assignedId}"><Avilable/></Validate>`;
      }
      break;
    }

    case "VMail": {
      const email = command.email?.trim() ?? "";
      const isValid = /^[\w._%+-]+@[\w.-]+\.[a-zA-Z]{2,4}$/.test(email);
      if (isValid) {
        body = '<Validate err="-1"/>';
      } else {
        body = '<Validate err="7"/>';
      }
      break;
    }

    case "Regist": {
      const username = command.user.trim();
      const password = command.password;
      const color = command.color ?? 1;
      const email = command.email;

      if (hasAccount(username, dataDir)) {
        body = '<Regist err="2"/>';
      } else {
        const regRes = createRegisteredAccount(username, password, color, email, dataDir);
        if (regRes.success) {
          body = '<Regist err="-1"/>';
        } else {
          body = '<Regist err="1"/>';
        }
      }
      break;
    }

    case "SetMobileToken": {
      body = '<MobileToken status="1"/>';
      break;
    }
  }

  const inner = `<Response cmd="${command.command}" t="${escapeXml(command.token)}">${body}</Response>`;
  const encoded = Buffer.from(inner, "utf8").toString("base64");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><mog>${encoded}</mog><md>${digest(encoded)}</md></Response>`;
}

export function buildLoginXmlResponse(valid = true): string {
  if (!valid) {
    return '<?xml version="1.0" encoding="utf-8"?><Root><Login status="2" allow="False" isMember="False"/></Root>';
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<Root>
    <Login status="1" allow="True" isMember="True">
        <status>1</status>
        <FirstLoadingScreens>
            <Screen i="1" t="1" />
        </FirstLoadingScreens>
    </Login>
</Root>`;
}

export function buildServersXmlResponse(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<Root>
    <Servers time="12:00:00">
        <S id="1" name="${LOCAL_SERVER.name}" ip="${LOCAL_SERVER.ip}" port="${LOCAL_SERVER.port}" webPort="${LOCAL_SERVER.webPort}" percentage="20" status="1" chatMode="true" friends="0" />
    </Servers>
</Root>`;
}
