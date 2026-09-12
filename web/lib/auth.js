'use client';
// Authentication state + route guard for every page.
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api } from './api';

export function useAuth() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('ff_token');
    const raw = localStorage.getItem('ff_user');
    if (!token || !raw) {
      router.replace('/login');
      return;
    }
    try { setUser(JSON.parse(raw)); } catch { router.replace('/login'); }
    setReady(true);
  }, [router]);

  const logout = useCallback(() => {
    localStorage.removeItem('ff_token');
    localStorage.removeItem('ff_user');
    router.replace('/login');
  }, [router]);

  return { user, ready, logout };
}
