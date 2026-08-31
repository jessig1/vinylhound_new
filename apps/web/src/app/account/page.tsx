"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import Link from "next/link";

import { isProductionAuth } from "../auth-mode";
import { Icon } from "../ui";
import { AccountDataActions } from "./account-data-actions";

export default function AccountPage() {
  return isProductionAuth ? <ClerkAccountPage /> : <DevelopmentAccountPage />;
}

function ClerkAccountPage() {
  const { user } = useUser();
  const { signOut } = useClerk();

  const name = user?.fullName ?? user?.username ?? "Your account";
  const email = user?.primaryEmailAddress?.emailAddress ?? "";

  return (
    <main className="content-page account-page">
      <header className="page-heading">
        <div>
          <p className="section-kicker">Settings</p>
          <h1>Account details</h1>
          <p>Manage your profile and VinylHound preferences.</p>
        </div>
      </header>
      <div className="account-grid">
        <section className="settings-card">
          <div className="settings-card__heading">
            <span>
              <Icon name="user" />
            </span>
            <div>
              <h2>Profile</h2>
              <p>The details shown around your account.</p>
            </div>
          </div>
          <label>
            <span>Display name</span>
            <input readOnly value={name} />
          </label>
          <label>
            <span>Email address</span>
            <input readOnly type="email" value={email} />
          </label>
          <p>
            Manage your name, email, and password from your account provider.
          </p>
        </section>
      </div>
      <Link className="text-button" href="/account/usage">
        <Icon name="sparkle" size={18} /> Usage and cost
      </Link>
      <AccountDataActions />
      <button
        className="signout-button"
        onClick={() => signOut({ redirectUrl: "/" })}
        type="button"
      >
        <Icon name="arrowLeft" size={18} /> Sign out
      </button>
    </main>
  );
}

function DevelopmentAccountPage() {
  return (
    <main className="content-page account-page">
      <header className="page-heading">
        <div>
          <p className="section-kicker">Settings</p>
          <h1>Account details</h1>
          <p>
            Local development uses a single fixed account (DEVELOPMENT_USER_ID);
            sign-in is only available when AUTH_MODE is production.
          </p>
        </div>
      </header>
      <Link className="text-button" href="/account/usage">
        <Icon name="sparkle" size={18} /> Usage and cost
      </Link>
      <AccountDataActions />
    </main>
  );
}
