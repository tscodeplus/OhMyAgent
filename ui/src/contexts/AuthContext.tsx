import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { getToken, setToken, clearToken, apiRequest } from '../utils/api';
import { isElectron } from '../utils/env';

interface AuthContextValue {
  isAuthenticated: boolean;
  token: string | null;
  login: (token: string) => Promise<boolean>;
  logout: () => void;
  isLoading: boolean;
  /** Non-null when a connection error prevented auth (e.g. remote gateway unreachable). */
  connectionError: string | null;
  /** The remote gateway URL that was being used, for display in error pages. */
  remoteUrl: string;
  /** Re-run the initial auth validation (useful after fixing connection settings). */
  retryAuth: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  isAuthenticated: false,
  token: null,
  login: async () => false,
  logout: () => {},
  isLoading: true,
  connectionError: null,
  remoteUrl: '',
  retryAuth: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(getToken());
  const [isLoading, setIsLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [remoteUrl, setRemoteUrl] = useState('');
  // Counter to allow retryAuth to re-trigger the effect
  const [retryCount, setRetryCount] = useState(0);
  // Ref to track whether the component is mounted.
  // Reset to true inside the effect so React StrictMode (which runs
  // effect→cleanup→effect on mount) doesn't leave it as false and
  // cause async callbacks to bail out prematurely.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const validateToken = useCallback(async (t: string): Promise<boolean> => {
    try {
      const result = await apiRequest<{ valid: boolean }>('/api/auth/verify', {
        headers: { Authorization: `Bearer ${t}` },
      });
      return result.valid;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    setConnectionError(null);

    // Electron desktop: auto-authenticate so the user never sees a login screen.
    if (isElectron()) {
      (async () => {
        // Check if we're connecting to a remote gateway (config set in desktop settings).
        // Remote gateways enforce token auth; we must use the configured remote token,
        // not the local 'electron-local' bypass value.
        let remoteToken = '';
        let configRemoteUrl = '';
        try {
          const config = (await window.electronAPI!.getGatewayConfig()) as {
            mode?: string; remoteUrl?: string; remoteToken?: string;
          };
          if (config?.mode === 'remote' && config?.remoteToken) {
            remoteToken = config.remoteToken;
            configRemoteUrl = config.remoteUrl || '';
          }
        } catch { /* preload may not have this API yet — fall back to local */ }

        if (remoteToken) {
          // Remote gateway mode — validate the configured token
          setRemoteUrl(configRemoteUrl);
          const valid = await validateToken(remoteToken);
          if (!mountedRef.current) return;
          if (valid) {
            setToken(remoteToken);
            setTokenState(remoteToken);
          } else {
            clearToken();
            setTokenState(null);
            // Set a descriptive error so the UI can show recovery options
            const baseMsg = configRemoteUrl
              ? `无法连接到远程网关 (${configRemoteUrl})`
              : '无法连接到远程网关';
            setConnectionError(baseMsg);
          }
        } else {
          // Local mode — use the Electron bypass token
          const electronToken = 'electron-local';
          setToken(electronToken);
          setTokenState(electronToken);
        }
        setIsLoading(false);
      })();
      return;
    }

    const savedToken = getToken();
    if (savedToken) {
      validateToken(savedToken)
        .then((valid) => {
          if (!mountedRef.current) return;
          if (valid) {
            setTokenState(savedToken);
          } else {
            clearToken();
            setTokenState(null);
          }
        })
        .finally(() => {
          if (mountedRef.current) setIsLoading(false);
        });
    } else {
      // Dev mode: auto-login if no token configured (backend will generate one)
      setIsLoading(false);
    }
  }, [validateToken, retryCount]);

  const login = useCallback(async (t: string): Promise<boolean> => {
    try {
      await apiRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ token: t }),
      });
      setToken(t);
      setTokenState(t);
      setConnectionError(null);
      return true;
    } catch {
      return false;
    }
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setTokenState(null);
  }, []);

  const retryAuth = useCallback(() => {
    setConnectionError(null);
    setIsLoading(true);
    setRetryCount(c => c + 1);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated: !!token,
        token,
        login,
        logout,
        isLoading,
        connectionError,
        remoteUrl,
        retryAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
