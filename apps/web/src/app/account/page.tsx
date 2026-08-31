"use client";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";

import { Icon } from "../ui";

export default function AccountPage() {
  const [name, setName] = useState("Alex Morgan");
  const [email, setEmail] = useState("collector@example.com");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem("vinylhound-demo-session");
    if (!stored) return;
    try {
      const session = JSON.parse(stored) as { name: string; email: string };
      setName(session.name);
      setEmail(session.email);
    } catch {
      // Keep the friendly demo defaults when local state is invalid.
    }
  }, []);

  function save(event: FormEvent) {
    event.preventDefault();
    window.localStorage.setItem(
      "vinylhound-demo-session",
      JSON.stringify({ name, email }),
    );
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }

  function signOut() {
    window.localStorage.removeItem("vinylhound-demo-session");
    window.location.assign("/");
  }

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
        <form className="settings-card" onSubmit={save}>
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
            <input
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </label>
          <label>
            <span>Email address</span>
            <input
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
            />
          </label>
          <div className="settings-actions">
            <button className="primary-button" type="submit">
              {saved ? (
                <>
                  <Icon name="check" size={18} /> Saved
                </>
              ) : (
                "Save changes"
              )}
            </button>
          </div>
        </form>
        <section className="settings-card">
          <div className="settings-card__heading">
            <span>
              <Icon name="settings" />
            </span>
            <div>
              <h2>Preferences</h2>
              <p>Customize your collecting experience.</p>
            </div>
          </div>
          <label className="toggle-row">
            <span>
              <strong>Scan reminders</strong>
              <small>Prompt me to review unfinished scans.</small>
            </span>
            <input defaultChecked type="checkbox" />
          </label>
          <label className="toggle-row">
            <span>
              <strong>Private collection</strong>
              <small>Keep lists visible only to you.</small>
            </span>
            <input defaultChecked type="checkbox" />
          </label>
        </section>
      </div>
      <Link className="text-button" href="/account/usage">
        <Icon name="sparkle" size={18} /> Usage and cost
      </Link>
      <button className="signout-button" onClick={signOut} type="button">
        <Icon name="arrowLeft" size={18} /> Sign out
      </button>
    </main>
  );
}
