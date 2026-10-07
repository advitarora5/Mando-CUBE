import { logout } from "./actions";

export function LogoutButton() {
  return <form action={logout}><button className="button secondary">Log out</button></form>;
}
