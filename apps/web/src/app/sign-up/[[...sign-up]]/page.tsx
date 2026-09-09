import { SignUp } from "@clerk/nextjs";

import { isProductionAuth } from "../../auth-mode";

export default function SignUpPage() {
  return isProductionAuth ? <ClerkSignUpPage /> : <DevelopmentSignUpPage />;
}

function ClerkSignUpPage() {
  return (
    <main className="auth-page auth-page--clerk">
      <SignUp
        signInFallbackRedirectUrl="/dashboard"
        fallbackRedirectUrl="/dashboard"
      />
    </main>
  );
}

function DevelopmentSignUpPage() {
  return (
    <main className="auth-page auth-page--clerk">
      <p>
        Sign-up is only available when AUTH_MODE is production. Local
        development uses a single fixed account (DEVELOPMENT_USER_ID).
      </p>
    </main>
  );
}
