import { useEffect, useRef, useCallback, useState } from 'react';
import type {
  WsServerMessage,
  WsSnapshotUpdate,
  WsDiscoveryUpdate,
  WsStatusUpdate,
  WsWelcome,
  BroadcastDay,
} from '@/types/api';

// ── Types ────────────────────────────────────────────────────────────────

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export interface UseWebSocketOptions {
  /** Series ID to subscribe to on connect. */
  seriesId?: string;
  /** WebSocket URL. Defaults to ws://localhost:3001 */
  url?: string;
  /** Called when a snapshot_update message is received. */
  onSnapshotUpdate?: (data: WsSnapshotUpdate['data']) => void;
  /** Called when a discovery_update message is received. */
  onDiscoveryUpdate?: (data: WsDiscoveryUpdate['data']) => void;
  /** Called when a status_update message is received. */
  onStatusUpdate?: (data: WsStatusUpdate['data']) => void;
  /** Called when the welcome message is received. */
  onWelcome?: (data: WsWelcome['data']) => void;
}

export interface UseWebSocketReturn {
  status: ConnectionStatus;
  lastMessage: WsServerMessage | null;
  welcomeData: WsWelcome['data'] | null;
  liveBroadcastDays: BroadcastDay[];
  reconnect: () => void;
  subscribe: (seriesId: string) => void;
  unsubscribe: (seriesId: string) => void;
}

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_WS_URL = import.meta.env.DEV
  ? `ws://${window.location.hostname}:${import.meta.env.VITE_WS_PORT ?? '3001'}`
  : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;
const PING_INTERVAL_MS = 25_000;

// ── Hook ─────────────────────────────────────────────────────────────────

export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const {
    seriesId,
    url = DEFAULT_WS_URL,
    onSnapshotUpdate,
    onDiscoveryUpdate,
    onStatusUpdate,
    onWelcome,
  } = options;

  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [lastMessage, setLastMessage] = useState<WsServerMessage | null>(null);
  const [welcomeData, setWelcomeData] = useState<WsWelcome['data'] | null>(null);
  const [liveBroadcastDays, setLiveBroadcastDays] = useState<BroadcastDay[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  // Store callbacks in refs so we don't reconnect when they change
  const callbacksRef = useRef({
    onSnapshotUpdate,
    onDiscoveryUpdate,
    onStatusUpdate,
    onWelcome,
  });
  callbacksRef.current = {
    onSnapshotUpdate,
    onDiscoveryUpdate,
    onStatusUpdate,
    onWelcome,
  };

  const cleanup = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (pingTimer.current) {
      clearInterval(pingTimer.current);
      pingTimer.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onclose = null;
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const subscribe = useCallback(
    (sid: string) => send({ type: 'subscribe', seriesId: sid }),
    [send],
  );

  const unsubscribe = useCallback(
    (sid: string) => send({ type: 'unsubscribe', seriesId: sid }),
    [send],
  );

  const connect = useCallback(() => {
    cleanup();
    if (!mountedRef.current) return;

    setStatus('connecting');

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setStatus('connected');
      reconnectAttempts.current = 0;

      // Subscribe to the series if provided
      if (seriesId) {
        send({ type: 'subscribe', seriesId });
      }

      // Start ping interval
      pingTimer.current = setInterval(() => {
        send({ type: 'ping' });
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const message = JSON.parse(event.data) as WsServerMessage;
        setLastMessage(message);

        switch (message.type) {
          case 'welcome':
            setWelcomeData(message.data);
            setLiveBroadcastDays(message.data.liveBroadcastDays);
            callbacksRef.current.onWelcome?.(message.data);
            break;
          case 'snapshot_update':
            callbacksRef.current.onSnapshotUpdate?.(message.data);
            break;
          case 'discovery_update':
            callbacksRef.current.onDiscoveryUpdate?.(message.data);
            break;
          case 'status_update': {
            callbacksRef.current.onStatusUpdate?.(message.data);
            // Update local broadcast day status tracking
            setLiveBroadcastDays((prev) =>
              prev
                .map((d) =>
                  d.id === message.data.broadcastDayId
                    ? { ...d, status: message.data.newStatus as BroadcastDay['status'] }
                    : d,
                )
                .filter((d) => d.status === 'live'),
            );
            break;
          }
          case 'pong':
            // Heartbeat acknowledged — nothing to do
            break;
          case 'error':
            console.warn('[WS] Server error:', message.data.message);
            break;
        }
      } catch {
        console.warn('[WS] Failed to parse message');
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      if (pingTimer.current) {
        clearInterval(pingTimer.current);
        pingTimer.current = null;
      }

      // Exponential backoff reconnect
      const attempt = reconnectAttempts.current;
      const delay = Math.min(
        BASE_RECONNECT_DELAY_MS * Math.pow(2, attempt),
        MAX_RECONNECT_DELAY_MS,
      );

      setStatus('reconnecting');
      reconnectAttempts.current = attempt + 1;

      reconnectTimer.current = setTimeout(() => {
        if (mountedRef.current) connect();
      }, delay);
    };

    ws.onerror = () => {
      // onclose will fire after onerror, which handles reconnect
    };
  }, [url, seriesId, cleanup, send]);

  const reconnect = useCallback(() => {
    reconnectAttempts.current = 0;
    connect();
  }, [connect]);

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      cleanup();
      setStatus('disconnected');
    };
  }, [connect, cleanup]);

  // Handle series change (subscribe to new, unsubscribe from old)
  const prevSeriesId = useRef(seriesId);
  useEffect(() => {
    if (status !== 'connected') return;
    if (prevSeriesId.current && prevSeriesId.current !== seriesId) {
      unsubscribe(prevSeriesId.current);
    }
    if (seriesId) {
      subscribe(seriesId);
    }
    prevSeriesId.current = seriesId;
  }, [seriesId, status, subscribe, unsubscribe]);

  return {
    status,
    lastMessage,
    welcomeData,
    liveBroadcastDays,
    reconnect,
    subscribe,
    unsubscribe,
  };
}
