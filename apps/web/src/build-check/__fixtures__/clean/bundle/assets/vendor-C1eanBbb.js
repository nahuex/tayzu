// A production React bundle names its error decoder page: an origin in a
// JavaScript asset is not an origin referenced by index.html.
const ERROR_DECODER = 'https://react.dev/errors/';

export function render(id) {
  return `${ERROR_DECODER}${id}`;
}
