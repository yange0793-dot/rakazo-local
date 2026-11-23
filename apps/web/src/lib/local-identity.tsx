import { createContext, useContext } from "react";

export type LocalUser = {
  id: string;
  name: string;
  email: string;
  image: null;
};

type LocalIdentityValue = {
  user: LocalUser;
  refresh: () => Promise<void>;
};

const LocalIdentityContext = createContext<LocalIdentityValue | null>(null);

export const LocalIdentityProvider = LocalIdentityContext.Provider;

export function useLocalIdentity(): LocalIdentityValue {
  const value = useContext(LocalIdentityContext);
  if (!value) throw new Error("Local identity is not available");
  return value;
}
