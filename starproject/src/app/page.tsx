import { redirect } from "next/navigation";

// Root is a placeholder for now — send people to the projects list.
export default function Home() {
  redirect("/projects");
}
