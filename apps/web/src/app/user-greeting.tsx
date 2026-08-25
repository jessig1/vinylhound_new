"use client";

import { useEffect, useState } from "react";

export function UserGreeting() {
  const [name, setName] = useState("Alex");

  useEffect(() => {
    const stored = window.localStorage.getItem("vinylhound-demo-session");
    if (!stored) return;

    try {
      const session = JSON.parse(stored) as { name?: string };
      const firstName = session.name
        ?.replace(/[._-]+/g, " ")
        .trim()
        .split(" ")[0];
      if (firstName) {
        setName(firstName[0].toUpperCase() + firstName.slice(1));
      }
    } catch {
      // Keep the demo greeting when local state is invalid.
    }
  }, []);

  return <h1>Good afternoon, {name}.</h1>;
}
