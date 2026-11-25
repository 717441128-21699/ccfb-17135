export const SEGMENT_COUNT = 36
export const FRAME_COUNT = 40

/** Synthetic master strip. Pixels map directly to captured macro frames. */
export const MASTER_WIDTH = 4000
export const MASTER_HEIGHT = 240
export const FRAME_WIDTH = 320
export const FRAME_HEIGHT = 240
export const FRAME_STEP = MASTER_WIDTH / FRAME_COUNT

/** Running band rectangle inside the 240px macro image. */
export const BAND_TOP = 56
export const BAND_BOTTOM = 184
export const BAND_HEIGHT = BAND_BOTTOM - BAND_TOP

export const MM_PER_PX = 0.12
export const CIRCUMFERENCE_MM = MASTER_WIDTH * MM_PER_PX

export const GRIT_OPTIONS = [120, 180, 240, 320, 400, 600, 800] as const

export const STORAGE_KEY = 'curling-band-reports-v1'
export const SETTINGS_KEY = 'curling-band-settings-v1'
