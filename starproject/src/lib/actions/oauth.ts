"use server";

import { redirect } from "next/navigation";

import { checkAuthorize, errorRedirect, issueCode, type AuthorizeParams } from "@/lib/oauth";
import { getCurrentDbUser } from "@/lib/user";

// The consent page's two buttons (src/app/oauth/authorize/page.tsx). The request
// arrives back as hidden form fields, so it is checked again here from scratch:
// nothing the page rendered is trusted. Being a server action also gives the
// Origin check a cross-site form post would otherwise need.

function paramsOf(form: FormData): AuthorizeParams {
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  return {
    response_type: get("response_type"),
    client_id: get("client_id"),
    redirect_uri: get("redirect_uri"),
    code_challenge: get("code_challenge"),
    code_challenge_method: get("code_challenge_method"),
    state: get("state"),
    scope: get("scope"),
    resource: get("resource"),
  };
}

export async function decideAuthorization(form: FormData): Promise<void> {
  const checked = await checkAuthorize(paramsOf(form));
  if (!checked.ok) {
    if ("redirect" in checked) redirect(checked.redirect);
    // Only a request edited since the page rendered it gets here.
    throw new Error(checked.fatal);
  }
  const { req } = checked;
  if (form.get("decision") !== "allow") {
    redirect(errorRedirect(req.redirectUri, { error: "access_denied", error_description: "The user declined." }, req.state));
  }
  const user = await getCurrentDbUser();
  redirect(await issueCode(req, user.id));
}
