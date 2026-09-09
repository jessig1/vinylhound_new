import { SignIn } from "@clerk/nextjs";

import { isProductionAuth } from "../../auth-mode";

export default function SignInPage() {
  return isProductionAuth ? <ClerkSignInPage /> : <DevelopmentSignInPage />;
}

function ClerkSignInPage() {
  return (
    <main className="auth-page auth-page--clerk">
      <SignIn
        signUpFallbackRedirectUrl="/dashboard"
        fallbackRedirectUrl="/dashboard"
      />
    </main>
  );
}

function DevelopmentSignInPage() {
  return (
    <main className="auth-page auth-page--clerk">
      <p>
        Sign-in is only available when AUTH_MODE is production. Local
        development uses a single fixed account (DEVELOPMENT_USER_ID).
      </p>
    </main>
  );
}
