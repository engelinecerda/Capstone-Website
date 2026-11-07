// Clickable, sortable table headers shared by the admin list pages.
//
// A header opts in with data-sort-key:
//     <th data-sort-key="customer">Customer</th>
// Optional: data-sort-first="desc" makes the first click sort descending
// (used for date columns, where newest-first is what people usually want).
//
// The header's text becomes the button, so the whole label is the click
// target. One small arrow sits beside it: hidden until the header is hovered
// or focused, then a single up or down arrow once that column is the sort.
//
// Clicking cycles  first direction -> opposite direction -> back to the
// page's default order. If the column IS the page's default sort, it just
// flips between ascending and descending.
//
// This module only tracks state and draws the headers. Server-paginated
// pages send getRpcParams() to their get_admin_*_page() call; pages that hold
// every row in the browser use sortRows().

const SVG_NS = 'http://www.w3.org/2000/svg';

function buildIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'th-sort-icon');
    svg.setAttribute('viewBox', '0 0 10 14');
    svg.setAttribute('width', '9');
    svg.setAttribute('height', '12');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const up = document.createElementNS(SVG_NS, 'path');
    up.setAttribute('class', 'i-up');
    up.setAttribute('d', 'M5 1 9 6H1z');
    const down = document.createElementNS(SVG_NS, 'path');
    down.setAttribute('class', 'i-down');
    down.setAttribute('d', 'M5 13 1 8h8z');
    svg.append(up, down);
    return svg;
}

/**
 * @param {Element} table  Any element containing the sortable <th>s.
 * @param {object}  [options]
 * @param {{key:string, dir:'asc'|'desc'}|null} [options.defaultSort]
 *        The order the page has when nothing was clicked. null = the page's
 *        own default (not a column), e.g. newest first.
 * @param {(sort:{key:string,dir:string}|null) => void} [options.onChange]
 *        Called after a header click with the sort now in effect.
 */
export function initTableSort(table, { defaultSort = null, onChange = null } = {}) {
    const headers = [...(table?.querySelectorAll('th[data-sort-key]') || [])];
    let explicit = null; // what the user picked; null = use defaultSort

    const effective = () => explicit || defaultSort;

    headers.forEach((th) => {
        const label = th.textContent.trim();
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'th-sort-btn';
        button.title = `Sort by ${label}`;
        const text = document.createElement('span');
        text.className = 'th-sort-label';
        text.textContent = label;
        button.append(text, buildIcon());
        th.textContent = '';
        th.appendChild(button);

        button.addEventListener('click', () => {
            const key = th.dataset.sortKey;
            const dirs = th.dataset.sortFirst === 'desc' ? ['desc', 'asc'] : ['asc', 'desc'];
            const current = effective();

            if (current && current.key === key) {
                const next = dirs[(dirs.indexOf(current.dir) + 1) % dirs.length];
                const isDefaultColumn = defaultSort && defaultSort.key === key;
                // Past the last direction: go back to the page default,
                // unless this column is the default (then just flip).
                if (!isDefaultColumn && current.dir === dirs[dirs.length - 1]) {
                    explicit = null;
                } else {
                    explicit = { key, dir: next };
                }
            } else {
                explicit = { key, dir: dirs[0] };
            }
            render();
            if (onChange) onChange(effective());
        });
    });

    function render() {
        const current = effective();
        headers.forEach((th) => {
            const active = current && current.key === th.dataset.sortKey;
            th.setAttribute('aria-sort', active ? (current.dir === 'desc' ? 'descending' : 'ascending') : 'none');
            th.classList.toggle('is-sorted', Boolean(active));
        });
    }
    render();

    return {
        /** The sort in effect ({key, dir}) or null for the page's own default. */
        getSort: effective,
        /** Extra RPC arguments for the server-paginated pages. */
        getRpcParams() {
            const current = effective();
            return current ? { p_sort_key: current.key, p_sort_dir: current.dir } : {};
        }
    };
}

// An RPC that gained p_sort_key/p_sort_dir only accepts them once
// 20261116_sortable_admin_lists.sql has been applied. Migrations here are
// applied by hand, so a deploy can land first: retry without them and the
// page still loads, in its previous order.
export async function rpcWithSort(supabase, fn, params, sortParams) {
    let result = await supabase.rpc(fn, { ...params, ...sortParams });
    const code = String(result.error?.code || '');
    if (result.error && Object.keys(sortParams).length
        && (code === 'PGRST202' || code === '42883' || /could not find the function/i.test(result.error.message || ''))) {
        result = await supabase.rpc(fn, params);
    }
    return result;
}

function isMissing(value) {
    return value === null || value === undefined || value === '' || Number.isNaN(value);
}

/**
 * Sort rows already in the browser. getters maps a sort key to a function
 * returning the value to compare. Empty values are listed last in either
 * direction; rows that compare equal keep their incoming order.
 */
export function sortRows(rows, sort, getters) {
    const getter = sort && getters[sort.key];
    if (!getter) return rows;
    const factor = sort.dir === 'desc' ? -1 : 1;

    return [...rows].sort((a, b) => {
        const left = getter(a);
        const right = getter(b);
        const leftMissing = isMissing(left);
        const rightMissing = isMissing(right);
        if (leftMissing || rightMissing) {
            return leftMissing === rightMissing ? 0 : (leftMissing ? 1 : -1);
        }
        if (typeof left === 'number' && typeof right === 'number') {
            return (left - right) * factor;
        }
        return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' }) * factor;
    });
}
