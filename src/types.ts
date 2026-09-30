// response contracts (only the fields we read)

export interface ZoomResult {
  componentName?: string;
  redirectUrl?: string;
  useWhichPasswd?: string;
  sharelevel?: string;
  action?: string;
  encryptMeetId?: string;
  fileId?: string;
  viewMp4Url?: string;
  mp4Url?: string;
  accessId?: string;
  duration?: number;
  recording?: { id?: string; playId?: string; fileSizeInMB?: string };
  meet?: { topic?: string };
}

export interface ZoomResponse {
  status?: boolean;
  errorMessage?: string;
  result?: ZoomResult | null;
}

export interface MediaMeta {
  viewUrl: string;
  playId: string;
  accessId: string;
  recordingId: string;
  duration: number;
  sizeMB: number;
  topic: string;
}
