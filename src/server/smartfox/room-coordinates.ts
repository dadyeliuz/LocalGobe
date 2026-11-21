/**
 * LocalGobe Authentic Room Spawn & Entry Points Database
 *
 * Provides authentic avatar coordinates when joining or transitioning between rooms:
 * 1. Physical Door Transitions (rooms__changeRoom): spawns at the door corresponding to the entry room.
 * 2. Map Teleport / Login / Jump (rooms__jumpToRoom, user__joinFirstRoom): spawns at the room's default spawn point.
 *
 * Coordinates extracted directly from authentic Mogobe room SWFs (DefineSprite PlaceObject2 tags).
 */

export interface SpawnLocation {
  readonly x: number;
  readonly y: number;
  readonly AD: number;
}

/**
 * Authentic physical door locations per target room.
 * Key: targetRoomId -> fromRoomId -> { x, y } (raw coordinates from SWF).
 */
export const AUTHENTIC_ROOM_DOORS: Readonly<Record<number, Readonly<Record<number, { readonly x: number; readonly y: number }>>>> = Object.freeze({
  // Room 20 (Tel Aviv / Main Entrance)
  20: {
    40: { x: 56.5, y: 286.6 },
    70: { x: 709.8, y: 241.1 },
    50: { x: -11.7, y: 245.6 },
    170: { x: 600.0, y: 290.9 },
    210: { x: 282.5, y: 208.9 },
    10139: { x: 537.2, y: 242.2 },
    10246: { x: 509.3, y: 170.1 },
  },
  // Room 50 (Bulletin Board / Tel Aviv Night)
  50: {
    20: { x: 721.1, y: 205.2 },
    500: { x: -16.4, y: 244.9 },
    3040: { x: 114.7, y: 154.2 },
    250: { x: -12.0, y: 147.2 },
    450: { x: 433.5, y: 204.9 },
  },
  // Room 60 (Azrieli Store)
  60: {
    170: { x: -0.4, y: 349.6 },
    230: { x: 388.1, y: 174.8 },
  },
  // Room 70 (Kings Road)
  70: {
    20: { x: -7.0, y: 247.2 },
    630: { x: 735.7, y: 324.5 },
    160: { x: 411.0, y: 144.1 },
    10112: { x: 209.1, y: 151.1 },
    3130: { x: 466.1, y: 113.5 },
    430: { x: 685.2, y: 112.7 },
  },
  // Room 100 (Jerusalem / Anticolum)
  100: {
    250: { x: 771.8, y: 298.9 },
    140: { x: -9.0, y: 246.6 },
    1150: { x: 470.1, y: 196.4 },
    10064: { x: 65.2, y: 357.0 },
    190: { x: 576.5, y: 276.4 },
  },
  // Room 110 (Beach / Eilat / Talina)
  110: {
    250: { x: 706.0, y: 216.7 },
    660: { x: 342.7, y: 126.8 },
    120: { x: 567.6, y: 301.9 },
    380: { x: -0.2, y: 402.1 },
    1140: { x: 98.2, y: 293.9 },
    150: { x: 474.2, y: 189.6 },
    10140: { x: 282.9, y: 350.6 },
  },
  // Room 120 (Hotel)
  120: {
    110: { x: 103.8, y: 331.1 },
    1051: { x: 248.8, y: 422.8 },
    150: { x: 707.8, y: 324.5 },
    2010: { x: 551.9, y: 182.3 },
    420: { x: 653.4, y: 161.2 },
    10040: { x: 225.3, y: 290.9 },
  },
  // Room 140 (Market)
  140: {
    130: { x: 629.5, y: 181.2 },
    100: { x: 773.0, y: 219.8 },
    1021: { x: 282.4, y: 269.9 },
    630: { x: 74.0, y: 219.7 },
    10064: { x: 269.4, y: 160.7 },
    10268: { x: 607.6, y: 306.6 },
  },
  // Room 150 (Pool)
  150: {
    120: { x: 733.2, y: 213.6 },
    1170: { x: 64.5, y: 336.9 },
  },
  // Room 170 (Mall)
  170: {
    20: { x: 514.7, y: 155.4 },
    180: { x: 659.8, y: 238.0 },
    60: { x: 243.5, y: 209.2 },
    1011: { x: 582.4, y: 384.5 },
    10016: { x: 76.8, y: 382.2 },
  },
  // Room 250 (Cinema / Desertia)
  250: {
    100: { x: -5.5, y: 276.7 },
    270: { x: 340.0, y: 273.0 },
    3060: { x: 96.7, y: 344.0 },
    110: { x: 723.0, y: 344.0 },
    10168: { x: 201.0, y: 149.7 },
    310: { x: 498.9, y: 282.9 },
  },
  // Room 310 (Library)
  310: {
    250: { x: 163.4, y: 261.2 },
    10006: { x: 774.9, y: 369.5 },
  },
  // Room 430 (Forest River)
  430: {
    70: { x: -0.2, y: 404.6 },
    440: { x: 392.2, y: 99.0 },
    770: { x: 76.8, y: 307.4 },
    10245: { x: 476.2, y: 172.3 },
    10209: { x: 370.1, y: 208.2 },
  },
  // Room 440 (Forest Tree)
  440: {
    430: { x: 181.1, y: 420.6 },
    470: { x: 383.5, y: 273.2 },
    3010: { x: 534.7, y: 415.6 },
    10218: { x: 260.4, y: 335.8 },
  },
  // Room 450 (Campsite / Forest)
  450: {
    50: { x: 163.4, y: 261.2 },
    490: { x: 760.5, y: 373.6 },
    460: { x: 567.8, y: 288.6 },
  },
  // Room 500 (Arava / Dunes / Boomags)
  500: {
    700: { x: 69.0, y: 340.1 },
    50: { x: 709.8, y: 350.4 },
    760: { x: -11.7, y: 371.4 },
    720: { x: 518.4, y: 301.9 },
    710: { x: 225.6, y: 318.8 },
    10009: { x: 620.1, y: 310.1 },
    10076: { x: 339.2, y: 406.1 },
    10080: { x: 470.1, y: 170.2 },
  },
  // Room 620 (Souvenir Store)
  620: {
    3110: { x: 705.3, y: 233.6 },
    10048: { x: 162.8, y: 469.7 },
  },
  // Room 630 (Village / HalavV)
  630: {
    70: { x: -22.4, y: 339.2 },
    140: { x: 725.8, y: 290.8 },
    10272: { x: 277.4, y: 324.4 },
    360: { x: 514.3, y: 303.5 },
  },
  // Room 660 (Shugi Beach)
  660: {
    110: { x: 60.8, y: 333.9 },
    760: { x: 567.0, y: 81.5 },
    10007: { x: 538.8, y: 320.7 },
    10155: { x: 85.5, y: 175.1 },
    10174: { x: 410.9, y: 164.1 },
  },
  // Room 760 (Mogo Bike / Nakik)
  760: {
    660: { x: -7.0, y: 277.7 },
    10233: { x: 335.6, y: 20.2 },
  },
  // Room 10010 (Castle / New Houses Area)
  10010: {
    10112: { x: 762.9, y: 355.1 },
    10013: { x: 140.9, y: 177.7 },
    10130: { x: 170.2, y: 357.9 },
    10150: { x: 309.9, y: 175.1 },
    10228: { x: 580.0, y: 148.9 },
  },
  // Room 10017 (World Adventure)
  10017: {
    500: { x: 723.0, y: 270.8 },
    660: { x: -7.0, y: 277.7 },
    760: { x: 112.5, y: 334.8 },
    10044: { x: 591.1, y: 261.0 },
    10046: { x: 401.8, y: 233.1 },
    10066: { x: 655.2, y: 352.9 },
  },
  // Room 10022 (Camp Area)
  10022: {
    110: { x: 660.0, y: 257.4 },
  },
  // Room 10030 (Amusement Park)
  10030: {
    10112: { x: 5.0, y: 343.0 },
  },
  // Room 10033 (Castle Gate)
  10033: {
    10064: { x: 5.0, y: 343.0 },
  },
  // Room 10064 (Independence Hall)
  10064: {
    100: { x: 686.9, y: 323.4 },
    140: { x: 213.9, y: 348.0 },
    10033: { x: 817.8, y: 539.4 },
  },
  // Room 10077 (Subway / Train Station)
  10077: {
    10092: { x: 544.6, y: 234.9 },
    10095: { x: 373.4, y: 218.0 },
    10096: { x: 209.6, y: 242.6 },
    10165: { x: 229.5, y: 81.0 },
  },
  // Room 10085 (Arcade)
  10085: {
    10162: { x: 8.6, y: 345.9 },
  },
  // Room 10098 (Ski Resort)
  10098: {
    10168: { x: 67.8, y: 236.6 },
  },
  // Room 10100 (Dressing Room)
  10100: {
    630: { x: 534.4, y: 387.9 },
  },
  // Room 10101 (Beauty Salon)
  10101: {
    440: { x: 9.5, y: 390.0 },
  },
  // Room 10109 (Village Bar)
  10109: {
    630: { x: 31.4, y: 294.7 },
    10117: { x: 678.1, y: 289.9 },
    3090: { x: 33.2, y: 404.9 },
  },
  // Room 10112 (Purim Carnival)
  10112: {
    10010: { x: -8.8, y: 316.4 },
    10115: { x: 341.4, y: 211.1 },
    70: { x: 473.4, y: 416.2 },
    10129: { x: 573.9, y: 273.8 },
    290: { x: 663.9, y: 328.8 },
    10007: { x: 39.6, y: 416.6 },
    10199: { x: 302.0, y: 385.4 },
  },
  // Room 10115 (Science Museum)
  10115: {
    10113: { x: 593.2, y: 317.9 },
    10114: { x: 18.6, y: 322.1 },
    10112: { x: 521.9, y: 477.1 },
    10132: { x: 264.4, y: 261.4 },
  },
  // Room 10130 (Train Station)
  10130: {
    10131: { x: 20.4, y: 194.6 },
    10010: { x: 442.3, y: 252.7 },
  },
  // Room 10162 (Secret Lair)
  10162: {
    10085: { x: 224.1, y: 245.8 },
  },
  // Room 10168 (Halloween Castle)
  10168: {
    100: { x: -5.5, y: 276.7 },
    250: { x: 723.0, y: 344.0 },
    10098: { x: 632.2, y: 222.3 },
  },
  // Room 10246 (Space Station)
  10246: {
    20: { x: 759.3, y: 389.6 },
    10247: { x: 571.2, y: 287.8 },
  },
  // Room 10268 (Passover Village)
  10268: {
    140: { x: 33.0, y: 316.7 },
  },
});

/**
 * Authentic default spawn locations per room (used when jumping via World Map, login, or direct join).
 */
export const AUTHENTIC_ROOM_DEFAULT_SPAWNS: Readonly<Record<number, SpawnLocation>> = Object.freeze({
  20: { x: 376, y: 372, AD: 4 },
  50: { x: 380, y: 330, AD: 4 },
  60: { x: 380, y: 330, AD: 4 },
  70: { x: 380, y: 320, AD: 4 },
  100: { x: 380, y: 330, AD: 4 },
  110: { x: 380, y: 340, AD: 4 },
  120: { x: 380, y: 330, AD: 4 },
  140: { x: 400, y: 310, AD: 4 },
  150: { x: 380, y: 330, AD: 4 },
  160: { x: 380, y: 320, AD: 4 },
  170: { x: 380, y: 330, AD: 4 },
  250: { x: 380, y: 330, AD: 4 },
  310: { x: 380, y: 330, AD: 4 },
  430: { x: 380, y: 330, AD: 4 },
  440: { x: 380, y: 330, AD: 4 },
  450: { x: 380, y: 330, AD: 4 },
  500: { x: 380, y: 350, AD: 4 },
  620: { x: 380, y: 330, AD: 4 },
  630: { x: 380, y: 320, AD: 4 },
  660: { x: 380, y: 320, AD: 4 },
  730: { x: 380, y: 330, AD: 4 },
  760: { x: 380, y: 330, AD: 4 },
  10010: { x: 380, y: 330, AD: 4 },
  10017: { x: 380, y: 330, AD: 4 },
  10022: { x: 380, y: 330, AD: 4 },
  10030: { x: 380, y: 330, AD: 4 },
  10033: { x: 380, y: 330, AD: 4 },
  10064: { x: 380, y: 330, AD: 4 },
  10077: { x: 380, y: 330, AD: 4 },
  10085: { x: 380, y: 330, AD: 4 },
  10098: { x: 380, y: 330, AD: 4 },
  10100: { x: 380, y: 330, AD: 4 },
  10101: { x: 380, y: 330, AD: 4 },
  10109: { x: 380, y: 330, AD: 4 },
  10112: { x: 380, y: 330, AD: 4 },
  10115: { x: 380, y: 330, AD: 4 },
  10130: { x: 380, y: 330, AD: 4 },
  10162: { x: 380, y: 330, AD: 4 },
  10168: { x: 380, y: 330, AD: 4 },
  10246: { x: 380, y: 330, AD: 4 },
  10268: { x: 380, y: 330, AD: 4 },
});

/**
 * Resolves the spawn location for an entering player.
 *
 * @param targetRoomId The destination room ID.
 * @param fromRoomId The room the player is exiting from (undefined for direct jumps/map teleports).
 * @returns Safe avatar coordinates and direction (AD) within the target room.
 */
export function resolveRoomSpawnLocation(
  targetRoomId: number,
  fromRoomId?: number,
): SpawnLocation {
  if (fromRoomId !== undefined && fromRoomId !== null && fromRoomId !== targetRoomId) {
    const roomDoors = AUTHENTIC_ROOM_DOORS[targetRoomId];
    const door = roomDoors ? roomDoors[fromRoomId] : undefined;
    if (door) {
      let x = door.x;
      let y = door.y;
      let ad = 4; // default front

      // Safely clamp coordinates slightly inside the room walking boundary
      if (x <= 60) {
        x = 75;
        ad = 6; // facing right (into the room)
      } else if (x >= 700) {
        x = 685;
        ad = 2; // facing left (into the room)
      }

      if (y < 190) {
        y = 210;
        ad = 4; // facing front/down
      } else if (y > 440) {
        y = 420;
        ad = 0; // facing back/up
      }

      return {
        x: Math.round(x),
        y: Math.round(y),
        AD: ad,
      };
    }
  }

  // Fallback to room's authentic default spawn point
  const defaultSpawn = AUTHENTIC_ROOM_DEFAULT_SPAWNS[targetRoomId];
  if (defaultSpawn) {
    return { ...defaultSpawn };
  }

  // Safe universal center of Mogobe stage (760x480 canvas)
  return { x: 380, y: 350, AD: 4 };
}
