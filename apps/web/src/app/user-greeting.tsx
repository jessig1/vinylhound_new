"use client";

import { useUser } from "@clerk/nextjs";

import { isProductionAuth } from "./auth-mode";

export function UserGreeting() {
  return isProductionAuth ? <ClerkGreeting /> : <h1>Good afternoon.</h1>;
}

function ClerkGreeting() {
  const { user } = useUser();
  const rawName = user?.firstName ?? user?.username ?? "";
  const firstName = rawName
    .replace(/[._-]+/g, " ")
    .trim()
    .split(" ")[0];
  const name = firstName
    ? firstName[0].toUpperCase() + firstName.slice(1)
    : "there";

  return <h1>Good afternoon, {name}.</h1>;
}
