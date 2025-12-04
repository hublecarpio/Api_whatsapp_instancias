export type ConnectionStatus = 'connected' | 'connecting' | 'requires_qr' | 'disconnected';

export interface InstanceMetadata {
  id: string;
  webhook: string;
  status: ConnectionStatus;
  createdAt: Date;
  lastConnection: Date | null;
}

export interface WebhookPayload {
  instanceId: string;
  event: string;
  payload: any;
  timestamp: string;
}

export interface SendMessageRequest {
  to: string;
  message: string;
}

export interface SendImageRequest {
  to: string;
  url: string;
  caption?: string;
}

export interface SendFileRequest {
  to: string;
  url: string;
  fileName: string;
  mimeType: string;
}

export interface CreateInstanceRequest {
  instanceId: string;
  webhook?: string;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}
