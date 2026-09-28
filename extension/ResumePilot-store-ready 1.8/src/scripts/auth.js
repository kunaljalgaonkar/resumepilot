/* Auth page — handles both login and register based on URL hash (#register / #login).
   UI-only: wired to api.js when you set BACKEND_URL. */
import { login, register } from "./api.js";
import { toast } from "./common.js";
import { icon } from "./icons.js";

const host = document.getElementById("formHost");

function render() {
  // Re-read hash each time so toggling #register / #login works without a reload
  const mode = location.hash === "#register" ? "register" : "login";
  const isReg = mode === "register";
  host.innerHTML = `
    <div class="label-overline mb-2">${isReg ? "Create account" : "Sign in"}</div>
    <h1 class="text-3xl font-black tracking-tight">
      ${isReg ? "Start tailoring — for free" : "Welcome back"}
    </h1>
    <p class="text-sm text-muted mt-2">
      ${isReg ? `Already have one? <a href="#login" class="text-ikb" style="font-weight:600">Sign in</a>` :
                 `New here? <a href="#register" class="text-ikb" style="font-weight:600">Create an account</a>`}
    </p>

    <form id="authForm" class="mt-8" style="display:flex;flex-direction:column;gap:14px">
      ${isReg ? `<div>
        <label class="label" for="name">Full name</label>
        <input class="input" id="name" name="name" autocomplete="name" required />
      </div>` : ""}
      <div>
        <label class="label" for="email">Email</label>
        <input class="input" id="email" name="email" type="email" autocomplete="email" required />
      </div>
      <div>
        <label class="label" for="password">Password</label>
        <div style="position:relative">
          <input class="input" id="password" name="password" type="password" autocomplete="${isReg ? "new-password" : "current-password"}" required minlength="8" />
          <button type="button" id="togglePw" aria-label="Show password"
            style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:transparent;border:none;cursor:pointer;color:var(--muted);padding:4px">
            ${icon("eye", 18)}
          </button>
        </div>
        ${isReg ? `<div class="help">At least 8 characters.</div>` : ""}
      </div>
      <button class="btn btn-lg btn-block mt-2" type="submit" id="submitBtn">
        ${isReg ? "Create account" : "Sign in"}
      </button>
    </form>

    <div style="display:flex;align-items:center;gap:12px;margin:24px 0">
      <div style="height:1px;flex:1;background:var(--border)"></div>
      <div class="label-overline">or</div>
      <div style="height:1px;flex:1;background:var(--border)"></div>
    </div>

    <button class="btn btn-outline btn-block" id="googleBtn"
      title="Sign in with Google">
      <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/></svg>
      Continue with Google
    </button>
  `;

  document.getElementById("togglePw").addEventListener("click", () => {
    const pw = document.getElementById("password");
    pw.type = pw.type === "password" ? "text" : "password";
  });

  document.getElementById("authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const payload = Object.fromEntries(fd.entries());
    const btn = document.getElementById("submitBtn");
    btn.disabled = true;
    btn.textContent = isReg ? "Creating account…" : "Signing in…";
    try {
      if (isReg) await register(payload);
      else await login(payload);
      toast("Welcome.", "success");
      location.href = "../onboarding/onboarding.html";
    } catch (err) {
      toast(err.detail || "Authentication failed", "error");
      btn.disabled = false;
      btn.textContent = isReg ? "Create account" : "Sign in";
    }
  });

  // Google OAuth — uses launchWebAuthFlow with a standard "Web application"
  // OAuth client (NOT the "Chrome Extension" client type). The Chrome
  // Extension client type requires Google's backend to recognize the exact
  // extension ID, which has proven unreliable to configure correctly.
  // launchWebAuthFlow instead redirects to a URL Chrome itself controls
  // (https://<extension-id>.chromiumapp.org/), which a normal Web
  // application OAuth client can be configured to allow as a redirect URI —
  // a much more standard, well-documented setup.
  const googleBtn = document.getElementById("googleBtn");

  const manifest = (typeof chrome !== "undefined" && chrome.runtime?.getManifest)
    ? chrome.runtime.getManifest()
    : {};
  const GOOGLE_CLIENT_ID = manifest?.oauth2?.client_id || "";

  if (!GOOGLE_CLIENT_ID) {
    googleBtn.disabled = true;
    googleBtn.title = "Add oauth2.client_id to manifest.json to enable Google sign-in";
  } else {
    googleBtn.addEventListener("click", () => {
      if (typeof chrome === "undefined" || !chrome.identity) {
        toast("Google sign-in is only available inside the extension.", "error");
        return;
      }

      // getRedirectURL() returns something like:
      // https://ebljlfkealolnldahddcdcmdpcllikfb.chromiumapp.org/
      // This EXACT string (including trailing slash) must be added as an
      // Authorized Redirect URI in Google Cloud Console → Credentials →
      // your OAuth client → Authorized redirect URIs.
      const redirectUri = chrome.identity.getRedirectURL();
      console.log("[auth] Google redirect URI (add this to GCP Console):", redirectUri);

      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
      authUrl.searchParams.set("response_type", "token");
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("scope", "openid email profile");
      authUrl.searchParams.set("prompt", "select_account");

      chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true }, async (responseUrl) => {
        if (chrome.runtime.lastError || !responseUrl) {
          const raw = chrome.runtime.lastError?.message || "";
          let msg = "Google sign-in failed.";
          if (/did not approve|user did not approve/i.test(raw)) {
            msg = "Google sign-in was cancelled.";
          } else if (/redirect_uri_mismatch/i.test(raw)) {
            // Copy the URI to clipboard so the user can paste it straight into GCP
            try { await navigator.clipboard.writeText(redirectUri); } catch (_) {}
            msg = `Redirect URI mismatch. The correct URI has been copied to your clipboard — paste it into Google Cloud Console → Credentials → your OAuth client → Authorized redirect URIs, then try again. URI: ${redirectUri}`;
          } else if (raw) {
            msg = `Google sign-in failed: ${raw}`;
          }
          toast(msg, "error");
          console.error("[auth] Google sign-in error:", raw, "| exact redirect URI to add:", redirectUri);
          return;
        }

        const fragment = new URL(responseUrl).hash.replace(/^#/, "");
        const params = new URLSearchParams(fragment);
        const token = params.get("access_token");
        const oauthError = params.get("error");

        if (oauthError) {
          toast(`Google sign-in failed: ${oauthError}`, "error");
          return;
        }
        if (!token) {
          toast("Google sign-in failed: no access token returned.", "error");
          return;
        }

        fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: { Authorization: "Bearer " + token }
        })
          .then(r => r.json())
          .then(async (profile) => {
            await register({ name: profile.name, email: profile.email, googleToken: token });
            toast("Welcome.", "success");
            location.href = "../onboarding/onboarding.html";
          })
          .catch(() => toast("Google sign-in failed", "error"));
      });
    });
  }
}

window.addEventListener("hashchange", render);
render();
