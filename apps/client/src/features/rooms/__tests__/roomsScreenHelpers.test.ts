import { describe, expect, it } from "vitest";
import type { Room } from "@concourse/contracts";
import { getRoomAccessibilityLabel, getRoomCard, getRoomsEmptyHint, getRoomsEmptyMessage } from "../roomsScreenHelpers";

describe("getRoomCard", () => {
  it("keeps the room title and formats the campus label", () => {
    const room: Room = {
      id: "auditorium",
      name: "Auditorium",
      campusId: "main-campus",
    };

    expect(getRoomCard(room)).toEqual({
      title: "Auditorium",
      subtitle: "Main Campus",
    });
  });
});

describe("room list helpers", () => {
  it("builds a spoken label with and without a campus", () => {
    expect(getRoomAccessibilityLabel({ id: "a", name: "Auditorium", campusId: "main-campus" } as Room, "Campus")).toBe(
      "Auditorium. Campus Main Campus.",
    );
    expect(getRoomAccessibilityLabel({ id: "a", name: "Auditorium" } as Room, "Campus")).toBe("Auditorium. ");
  });

  it("selects search-specific or default empty copy", () => {
    const t = (key: string, values?: Record<string, string | number>) => `${key}:${values?.search ?? ""}`;
    expect(getRoomsEmptyMessage("lab", t)).toBe("noMatchingRooms:lab");
    expect(getRoomsEmptyMessage("", t)).toBe("noRooms:");
    expect(getRoomsEmptyHint("lab", t)).toBe("searchEmptyHint:");
    expect(getRoomsEmptyHint("", t)).toBe("roomsEmptyHint:");
  });
});
