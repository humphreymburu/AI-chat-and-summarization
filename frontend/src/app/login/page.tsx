import type { Metadata } from "next";

import AuthForm from "@unep/components/AuthForm";

export const metadata: Metadata = {
  title: "Log in — Environment Knowledge",
};

export default function Page() {
  return (
    <div className="kb-root kb-auth-page">
      <AuthForm mode="login" />
    </div>
  );
}
