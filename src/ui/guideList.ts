/**
 * The channel list shown by the TV tab (selected category, same order), handed to the guide so
 * both screens show the same channels in the same order.
 */
let list: string[] | null = null;

export function setGuideList(ids: string[] | null) {
  list = ids;
}

export function getGuideList(): string[] | null {
  return list;
}
