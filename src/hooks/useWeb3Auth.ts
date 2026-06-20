"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Keypair } from "@stellar/stellar-sdk";

interface AuthSession {
  address: string;
  network: string;
  signature: string;
  expiresAt: number;
}

interface UseWeb3AuthReturn {
  account: { address: string; network: string } | null;
  isConnected: boolean;
  isAuthenticated: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  signChallenge: (challenge: string) => Promise<string>;
}

const CHALLENGE_DURATION_MS = 30 * 60 * 1000;

export function useWeb3Auth(): UseWeb3AuthReturn {
  const [session, setSession] = useState<AuthSession | null>(null);
  const keypairRef = useRef<Keypair | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("utility-auth-session");
    if (stored) {
      try {
        const parsed: AuthSession = JSON.parse(stored);
        if (parsed.expiresAt > Date.now()) {
          setSession(parsed);
          import("@stellar/stellar-sdk").then(({ Keypair: StellarKeypair }) => {
            keypairRef.current = StellarKeypair.fromSecret(
              localStorage.getItem("utility-auth-secret") || ""
            );
          }).catch(() => {
            // Secret is invalid or not available; keypair remains null.
            // Signing will throw a descriptive error when attempted.
          });
        } else {
          localStorage.removeItem("utility-auth-session");
          localStorage.removeItem("utility-auth-secret");
        }
      } catch {
        localStorage.removeItem("utility-auth-session");
        localStorage.removeItem("utility-auth-secret");
      }
    }
  }, []);

  const signChallenge = useCallback(async (challenge: string): Promise<string> => {
    const kp = keypairRef.current;
    if (!kp) throw new Error("No keypair available for signing");
    const buffer = Buffer.from(challenge, "utf-8");
    return kp.sign(buffer).toString("hex");
  }, []);

  const connect = useCallback(async () => {
    const { Keypair: StellarKeypair } = await import("@stellar/stellar-sdk");
    const kp = StellarKeypair.random();
    keypairRef.current = kp;
    const challenge = `Utility-Protocol Auth: ${Date.now()}`;
    const buffer = Buffer.from(challenge, "utf-8");
    const signature = kp.sign(buffer).toString("hex");
    const authSession: AuthSession = {
      address: kp.publicKey(),
      network: "testnet",
      signature,
      expiresAt: Date.now() + CHALLENGE_DURATION_MS,
    };
    localStorage.setItem("utility-auth-session", JSON.stringify(authSession));
    localStorage.setItem("utility-auth-secret", kp.secret());
    setSession(authSession);
  }, []);

  const disconnect = useCallback(async () => {
    keypairRef.current = null;
    setSession(null);
    localStorage.removeItem("utility-auth-session");
    localStorage.removeItem("utility-auth-secret");
  }, []);

  return {
    account: session
      ? { address: session.address, network: session.network }
      : null,
    isConnected: !!session,
    isAuthenticated: !!session && session.expiresAt > Date.now(),
    connect,
    disconnect,
    signChallenge,
  };
}
