
    import { supabase } from '../js/supabase.js';

    const { data: { session } } = await supabase.auth.getSession();
    const isLoggedIn = !!session;

    const S = {
        eventType: '', guestCount: '', eventDate: '',
        locationType: '', venueLocation: '',
        miniPackage: null, snackAddon: null,
        offsiteCategory: '', offsitePackage: null,
        cateringCart: [],
        name: '', phone: '', email: '', requests: '',
        time: ''
    };

    const CONTRACT_FILES = {
        onsite_vip: '../files/contracts/contract-vip-lounge.pdf',
        onsite_main_hall: '../files/contracts/contract-main-hall.pdf',
        onsite_default: '',
        add_on_snack: '../files/contracts/contract-snack-bar.pdf',
        offsite_coffee: '../files/contracts/contract-coffee-bar.pdf',
        offsite_snack: '../files/contracts/contract-snack-bar.pdf',
        offsite_catering: '../files/contracts/contract-catering.pdf',
        default: ''
    };

    // These are populated from the Supabase `package` table
    let MINI        = [];
    let SNACK       = [];
    let OFFSITE_PKGS = { coffee: [], snack: [], catering: [] };

    const OFFSITE_CATS = [
        { label:'Eli Coffee Bar',   val:'coffee',   icon:'&#9749;',   desc:'Professional coffee bar service for your event' },
        { label:'Snack Bar Corner', val:'snack',    icon:'&#127850;', desc:'Mobile snack bar with chocolate fountain' },
        { label:'Catering',         val:'catering', icon:'&#127869;&#65039;', desc:'Full catering service with buffet setup, styled tables &amp; more' }
    ];

    // ── Load packages from Supabase ──
    async function loadPackages() {
        const { data: pkgs, error } = await supabase
            .from('package')
            .select('package_id, package_name, description, package_type, price, guest_capacity, location_type')
            .eq('is_active', true)
            .order('price', { ascending: true });

        if (error || !pkgs) { console.error('Failed to load packages:', error); return; }

        MINI  = [];
        SNACK = [];
        OFFSITE_PKGS = { coffee: [], snack: [], catering: [] };

        pkgs.forEach(p => {
            const base   = {
                id: p.package_id,
                label: p.package_name,
                price: p.price,
                desc: p.description || '',
                contract: getContractFileForPackage(p)
            };
            const isAddon = p.package_type === 'add on' || p.package_type === 'add_on';

            if (p.location_type === 'onsite') {
                if (isAddon) {
                    SNACK.push(base);
                } else {
                    // main onsite package
                    MINI.push({ ...base, pax: p.guest_capacity ? p.guest_capacity + ' pax' : '' });
                }
            } else if (p.location_type === 'offsite') {
                // Infer offsite category from package name since package_type is only 'main'/'add on'
                const name = p.package_name.toLowerCase();
                if (name.includes('coffee'))   OFFSITE_PKGS.coffee.push(base);
                else if (name.includes('snack') || name.includes('biscuit')) OFFSITE_PKGS.snack.push(base);
                else if (name.includes('catering')) OFFSITE_PKGS.catering.push(base);
                else OFFSITE_PKGS.catering.push(base); // fallback
            }
        });
    }

    const DISHES = [
        { cat:'Chicken',    icon:'&#127831;', tag:'main',    required:true,  items:['Chicken ala King','Chicken Fillet w/ White Sauce','Garlic Butter Chicken'] },
        { cat:'Pork',       icon:'&#129385;', tag:'main',    required:true,  items:['Pork with Mushroom','Crunchy Pork','Pork Caldereta'] },
        { cat:'Beef',       icon:'&#129385;', tag:'main',    required:true,  items:['Beef Teriyaki','Beef Salpicao','Beef and Broccoli'] },
        { cat:'Fish',       icon:'&#128031;', tag:'main',    required:true,  items:['Fish Fillet with Tartar Sauce','Sweet and Sour Fish Fillet'] },
        { cat:'Vegetables', icon:'&#129382;', tag:'main',    required:true,  items:['Mixed Vegetables in Butter Corn and Carrots','Potato Marble'] },
        { cat:'Pasta',      icon:'&#127837;', tag:'pasta',   required:true,  items:['Spaghetti','Carbonara','Baked Macaroni','Tuna Pesto','Pancit Canton'] },
        { cat:'Dessert',    icon:'&#127854;', tag:'dessert', required:true,  items:['Coffee Jelly','Buko Pandan','Mango Sago','Chocolate Mousse'] },
        { cat:'Rice',       icon:'&#127834;', tag:'rice',    required:false, items:['Steamed Rice'] }
    ];

    const PRICES = {
        Chicken:    {20:2700, 30:3800, 40:4800, 50:5900},
        Pork:       {20:2700, 30:3800, 40:4800, 50:5900},
        Beef:       {20:2700, 30:3800, 40:4800, 50:5900},
        Fish:       {20:2400, 30:3400, 40:4500, 50:5600},
        Vegetables: {20:2400, 30:3400, 40:4500, 50:5600},
        Pasta:      {20:2000, 30:2900, 40:3800, 50:4600},
        Dessert:    {20:1400, 30:2900, 40:2600, 50:3200},
        Rice:       {20:600,  30:900,  40:1200, 50:1500}
    };

    const TIMES = ['1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM',
                   '6:00 PM','7:00 PM','8:00 PM','9:00 PM','10:00 PM'];

    function fmtPeso(value) {
        return '\u20B1' + Number(value || 0).toLocaleString();
    }

    function hasCateringTag(tag) {
        return DISHES
            .filter(group => group.tag === tag)
            .some(group => S.cateringCart.some(item => item.cat === group.cat && item.pax));
    }

    function isCateringSelectionValid() {
        return hasCateringTag('main') && hasCateringTag('pasta') && hasCateringTag('dessert');
    }

    function getCateringCartTotal() {
        return S.cateringCart.reduce((sum, item) => sum + (item && item.pax ? item.price : 0), 0);
    }

    function getCateringCartCount() {
        return S.cateringCart.filter(item => item && item.pax).length;
    }

    // ── Step order: Time Slot (rs5) now comes BEFORE Your Details (rs4) ──
    const STEP_IDS = ['rs1','rs2','rs3','rs5','rs4','rs6','rs7'];

    let cur = 1;
    function total() { return STEP_IDS.length; }
    function sid(n)  { return STEP_IDS[n - 1]; }

    function showStep(n) {
        document.querySelectorAll('.res-step').forEach(s => s.classList.remove('active'));
        document.getElementById(sid(n)).classList.add('active');

        document.getElementById('progress').style.width = (n / total() * 100) + '%';
        document.getElementById('step-text').textContent =
            'Step ' + n + ' of ' + total() + ': ' + document.getElementById(sid(n)).querySelector('h2').textContent;

        document.getElementById('prevBtn').classList.toggle('hidden', n === 1);
        document.getElementById('nextBtn').textContent = n === total() ? 'Submit' : 'Next \u2192';

        populate(sid(n));
    }

    function populate(id) {
        if (id === 'rs3') buildStep3();
        if (id === 'rs5') buildTimeGrid();
        if (id === 'rs6') buildSummary();
        if (id === 'rs7') buildContractDownload();
    }

    function getContractFileForPackage(pkg) {
        const name = (pkg.package_name || '').toLowerCase();
        const location = (pkg.location_type || '').toLowerCase();

        if (location === 'onsite') {
            if (name.includes('vip')) return CONTRACT_FILES.onsite_vip;
            if (name.includes('main hall')) return CONTRACT_FILES.onsite_main_hall;
            if (name.includes('snack') || name.includes('biscuit')) return CONTRACT_FILES.add_on_snack;
            return CONTRACT_FILES.onsite_default;
        }

        if (location === 'offsite') {
            if (name.includes('coffee')) return CONTRACT_FILES.offsite_coffee;
            if (name.includes('snack') || name.includes('biscuit')) return CONTRACT_FILES.offsite_snack;
            if (name.includes('catering')) return CONTRACT_FILES.offsite_catering;
        }

        return CONTRACT_FILES.default;
    }

    function getSelectedContractInfo() {
        if (S.locationType === 'onsite') {
            if (!S.miniPackage) return null;
            return {
                title: S.miniPackage.label + ' Contract',
                description: 'Download the contract for your selected package before signing.',
                downloadUrl: S.miniPackage.contract || CONTRACT_FILES.onsite_default,
                contractType: 'package_contract'
            };
        }

        if (S.offsiteCategory === 'catering') {
            const cateringPkg = OFFSITE_PKGS.catering[0];
            return {
                title: 'Catering Package Contract',
                description: 'Download the contract for your selected offsite catering package.',
                downloadUrl: cateringPkg?.contract || CONTRACT_FILES.offsite_catering,
                contractType: 'package_contract'
            };
        }

        if (S.offsitePackage) {
            return {
                title: S.offsitePackage.label + ' Contract',
                description: 'Download the contract for your selected package before signing.',
                downloadUrl: S.offsitePackage.contract || CONTRACT_FILES.default,
                contractType: 'package_contract'
            };
        }

        return null;
    }

    function buildContractDownload() {
        const info = getSelectedContractInfo();
        const btn = document.getElementById('contract-download-btn');
        const title = document.getElementById('contract-title');
        const description = document.getElementById('contract-description');

        if (!btn || !title || !description) return;

        if (!info) {
            btn.href = '#';
            btn.removeAttribute('download');
            btn.setAttribute('aria-disabled', 'true');
            title.textContent = 'ELI Coffee Events Reservation Contract';
            description.textContent = 'Select a package first so the correct contract file can be downloaded.';
            return;
        }

        btn.href = info.downloadUrl;
        btn.setAttribute('download', '');
        btn.removeAttribute('aria-disabled');
        title.textContent = info.title;
        description.textContent = info.description;
    }

    function buildStep3() {
        const onEl  = document.getElementById('onsite-section');
        const offEl = document.getElementById('offsite-section');
        if (S.locationType === 'onsite') {
            onEl.classList.remove('hidden');
            offEl.classList.add('hidden');
            document.getElementById('rs3-desc').textContent = 'Select a gathering package for your event';
            buildMiniGrid();
        } else {
            onEl.classList.add('hidden');
            offEl.classList.remove('hidden');
            document.getElementById('rs3-desc').textContent = 'Choose the type of service you need';
            buildOffsiteCats();
        }
    }

    function buildMiniGrid() {
        const g = document.getElementById('mini-grid');
        g.innerHTML = '';
        MINI.forEach(p => {
            const c = card(
                '<h4>' + p.label + '</h4>' +
                '<div class="pkg-price">&#8369;' + p.price.toLocaleString() + '</div>' +
                '<p class="pkg-desc">' + p.pax + ' &bull; ' + p.hours + '<br>' + p.credit + '</p>',
                S.miniPackage && S.miniPackage.label === p.label
            );
            c.onclick = () => {
                S.miniPackage = p;
                activate(g, c);
                document.getElementById('snack-addon').classList.remove('hidden');
                buildSnackGrid();
            };
            g.appendChild(c);
        });
    }

    function buildSnackGrid() {
        const g = document.getElementById('snack-grid');
        g.innerHTML = '';
        const none = card('<h4>No Add-on</h4><p class="pkg-desc">Skip the snack bar</p>', S.snackAddon === null);
        none.onclick = () => { S.snackAddon = null; activate(g, none); };
        g.appendChild(none);
        SNACK.forEach(p => {
            const c = card(
                '<h4>' + p.label + '</h4>' +
                '<div class="pkg-price">&#8369;' + p.price.toLocaleString() + '</div>' +
                '<p class="pkg-desc">' + p.desc + '</p>',
                S.snackAddon && S.snackAddon.label === p.label
            );
            c.onclick = () => { S.snackAddon = p; activate(g, c); };
            g.appendChild(c);
        });
    }

    function buildOffsiteCats() {
        const g = document.getElementById('offsite-cat-grid');
        g.innerHTML = '';
        const icons = { coffee:'&#9749;', snack:'&#127850;', catering:'&#127869;&#65039;' };
        OFFSITE_CATS.forEach(p => {
            const c = card(
                '<h4>' + (icons[p.val] || '') + ' ' + p.label + '</h4><p class="pkg-desc">' + p.desc + '</p>',
                S.offsiteCategory === p.val
            );
            c.onclick = () => {
                S.offsiteCategory = p.val;
                S.offsitePackage  = null;
                S.cateringCart    = [];
                activate(g, c);

                const subEl      = document.getElementById('offsite-sub');
                const cateringEl = document.getElementById('catering-section');

                if (p.val === 'catering') {
                    subEl.classList.add('hidden');
                    cateringEl.classList.remove('hidden');
                    buildCateringDishBuilder();
                } else {
                    cateringEl.classList.add('hidden');
                    subEl.classList.remove('hidden');
                    document.getElementById('offsite-sub-label').textContent = 'Choose a ' + p.label + ' Package';
                    buildOffsiteSub(p.val);
                }
            };
            g.appendChild(c);
        });

        if (S.offsiteCategory === 'catering') {
            document.getElementById('offsite-sub').classList.add('hidden');
            document.getElementById('catering-section').classList.remove('hidden');
            buildCateringDishBuilder();
        } else if (S.offsiteCategory && S.offsiteCategory !== 'catering') {
            document.getElementById('catering-section').classList.add('hidden');
            document.getElementById('offsite-sub').classList.remove('hidden');
            buildOffsiteSub(S.offsiteCategory);
        }
    }

    function buildOffsiteSub(val) {
        const g = document.getElementById('offsite-sub-grid');
        g.innerHTML = '';
        (OFFSITE_PKGS[val] || []).forEach(p => {
            const c = card(
                '<h4>' + p.label + '</h4>' +
                '<div class="pkg-price">' + (p.price > 0 ? '&#8369;' + p.price.toLocaleString() : 'Contact for quote') + '</div>' +
                '<p class="pkg-desc">' + p.desc + '</p>',
                S.offsitePackage && S.offsitePackage.label === p.label
            );
            c.onclick = () => { S.offsitePackage = p; activate(g, c); };
            g.appendChild(c);
        });
    }

    function buildCateringDishBuilder() {
        const builder = document.getElementById('catering-tray-builder');
        builder.innerHTML = '';

        DISHES.forEach(group => {
            const selection = S.cateringCart.find(item => item.cat === group.cat);
            const done = selection && selection.pax;

            const section = document.createElement('div');
            section.className = 'cat-section';

            const header = document.createElement('div');
            header.className = 'cat-header';
            header.innerHTML =
                '<div class="cat-icon-wrap">' + group.icon + '</div>' +
                '<span class="cat-title">' + group.cat + '</span>' +
                '<span class="cat-tag">' + (group.required ? '(required)' : '(optional add-on)') + '</span>' +
                '<span class="cat-done-badge' + (done ? ' visible' : '') + '">&#10003; Added</span>';
            section.appendChild(header);

            const grid = document.createElement('div');
            grid.className = 'dish-grid';

            group.items.forEach(item => {
                const isSelected = selection && selection.dish === item;
                const card = document.createElement('div');
                card.className = 'dish-card' + (isSelected ? ' selected' : '');
                card.innerHTML =
                    '<div class="dish-name">' + item + '</div>' +
                    '<div class="dish-status checked">&#10003; Selected</div>' +
                    '<div class="dish-status remove">&#10005; Click to remove</div>';

                card.onclick = () => {
                    if (isSelected) {
                        S.cateringCart = S.cateringCart.filter(entry => entry.cat !== group.cat);
                    } else {
                        S.cateringCart = S.cateringCart.filter(entry => entry.cat !== group.cat);
                        S.cateringCart.push({ cat: group.cat, dish: item, pax: null, price: 0 });
                    }
                    rebuildCateringUI();
                };
                grid.appendChild(card);
            });
            section.appendChild(grid);

            if (selection && selection.dish) {
                const paxWrap = document.createElement('div');
                paxWrap.className = 'pax-wrapper visible';

                const paxTop = document.createElement('div');
                paxTop.className = 'pax-top';
                paxTop.innerHTML =
                    '<span class="pax-top-label">Pax per tray</span>' +
                    (selection.pax ? '<span class="pax-selected-price">' + fmtPeso(PRICES[group.cat][selection.pax]) + '</span>' : '');
                paxWrap.appendChild(paxTop);

                const paxBtns = document.createElement('div');
                paxBtns.className = 'pax-buttons';

                [20, 30, 40, 50].forEach(n => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'pax-btn' + (selection.pax === n ? ' selected' : '');
                    btn.textContent = n + ' pax';
                    btn.onclick = () => {
                        const price = PRICES[group.cat][n] || 0;
                        S.cateringCart = S.cateringCart.filter(entry => entry.cat !== group.cat);
                        S.cateringCart.push({ cat: group.cat, dish: selection.dish, pax: n, price });
                        rebuildCateringUI();
                    };
                    paxBtns.appendChild(btn);
                });
                paxWrap.appendChild(paxBtns);

                if (!selection.pax) {
                    const hint = document.createElement('p');
                    hint.className = 'pax-hint';
                    hint.textContent = 'Choose the number of pax to add this dish to your cart.';
                    paxWrap.appendChild(hint);
                }

                section.appendChild(paxWrap);
            }

            const hr = document.createElement('hr');
            hr.className = 'cat-divider';
            section.appendChild(hr);
            builder.appendChild(section);
        });

        renderCateringCart();
        renderCateringProgress();
    }

    function rebuildCateringUI() {
        buildCateringDishBuilder();
    }

    function renderCateringProgress() {
        const tracker = document.getElementById('catering-progress-tracker');
        if (!tracker) return;

        const steps = [
            {
                label: 'Main Dish',
                check: () => DISHES.filter(group => group.tag === 'main').some(group => S.cateringCart.some(item => item.cat === group.cat && item.pax))
            },
            { label: 'Pasta', check: () => hasCateringTag('pasta') },
            { label: 'Dessert', check: () => hasCateringTag('dessert') },
            { label: 'Rice', check: () => hasCateringTag('rice'), optional: true }
        ];

        tracker.innerHTML = '';
        steps.forEach((step, index) => {
            const done = step.check();
            const item = document.createElement('div');
            item.className = 'pt-item' + (done ? ' done' : ' pending');
            item.innerHTML =
                '<div class="pt-dot">' + (done ? '&#10003;' : (index + 1)) + '</div>' +
                '<span>' + step.label + (step.optional ? ' <em style="font-weight:400;font-style:normal;opacity:0.6">(optional)</em>' : '') + '</span>';
            tracker.appendChild(item);

            if (index < steps.length - 1) {
                const divider = document.createElement('div');
                divider.className = 'pt-divider';
                tracker.appendChild(divider);
            }
        });
    }

    function renderCateringCart() {
        const rows = document.getElementById('catering-tray-rows');
        const emptyEl = document.getElementById('catering-cart-empty');
        const footerEl = document.getElementById('catering-cart-footer');
        const badgeEl = document.getElementById('catering-cart-badge');
        const runningEl = document.getElementById('catering-cart-running-total');
        const countEl = document.getElementById('catering-cart-footer-count');
        const totalEl = document.getElementById('catering-tray-total');
        const noticeEl = document.getElementById('catering-validation-notice');
        const noticeText = document.getElementById('catering-validation-text');

        rows.innerHTML = '';
        const count = getCateringCartCount();
        const total = getCateringCartTotal();

        badgeEl.textContent = count;
        runningEl.textContent = fmtPeso(total);

        if (count === 0) {
            emptyEl.style.display = 'block';
            footerEl.style.display = 'none';
        } else {
            emptyEl.style.display = 'none';
            footerEl.style.display = 'flex';
            countEl.textContent = count + ' dish' + (count !== 1 ? 'es' : '') + ' selected';
            totalEl.textContent = fmtPeso(total);

            S.cateringCart.forEach(i => {
                if (!i || !i.pax) return;
                const row = document.createElement('div');
                row.className = 'cart-item';
                row.innerHTML =
                    '<div class="ci-indicator"></div>' +
                    '<div>' +
                        '<div class="ci-cat">' + i.cat + '</div>' +
                        '<div class="ci-dish">' + i.dish + '</div>' +
                        '<div class="ci-pax">' + i.pax + ' pax</div>' +
                    '</div>' +
                    '<div class="ci-right">' +
                        '<span class="ci-price">' + fmtPeso(i.price) + '</span>' +
                        '<button type="button" class="ci-remove-btn" data-cat="' + i.cat + '">Remove</button>' +
                    '</div>';
                rows.appendChild(row);
            });

            rows.querySelectorAll('.ci-remove-btn').forEach(btn => {
                btn.onclick = () => {
                    S.cateringCart = S.cateringCart.filter(item => item.cat !== btn.dataset.cat);
                    rebuildCateringUI();
                };
            });
        }

        const valid = isCateringSelectionValid();
        noticeEl.className = 'validation-notice' + (valid ? ' success' : '');
        if (valid) {
            noticeEl.querySelector('.vn-icon').textContent = '✅';
            noticeText.textContent = 'Great! Your menu meets the minimum requirements. You can add more dishes if you like.';
        } else {
            noticeEl.querySelector('.vn-icon').textContent = '⚠️';
            const missing = [];
            if (!hasCateringTag('main')) missing.push('1 main dish');
            if (!hasCateringTag('pasta')) missing.push('1 pasta');
            if (!hasCateringTag('dessert')) missing.push('1 dessert');
            noticeText.textContent = 'Still needed: ' + missing.join(', ') + '.';
        }
    }

    function buildTimeGrid() {
        const g = document.getElementById('time-grid');
        g.innerHTML = '';
        TIMES.forEach(t => {
            const c = document.createElement('div');
            c.className = 'time-card' + (S.time === t ? ' active' : '');
            c.textContent = t;
            c.onclick = () => {
                S.time = t;
                g.querySelectorAll('.time-card').forEach(x => x.classList.remove('active'));
                c.classList.add('active');
            };
            g.appendChild(c);
        });
    }

    function buildSummary() {
        const box = document.getElementById('summary-content');
        let pkgRows = '';
        let total   = 0;

        if (S.locationType === 'onsite') {
            if (S.miniPackage) {
                total += S.miniPackage.price;
                pkgRows += sr('Package', S.miniPackage.label + ' &mdash; &#8369;' + S.miniPackage.price.toLocaleString());
                pkgRows += sr('Inclusions', S.miniPackage.pax + ' &bull; ' + S.miniPackage.hours + ' &bull; ' + S.miniPackage.credit);
            }
            if (S.snackAddon) {
                total += S.snackAddon.price;
                pkgRows += sr('Snack Bar Add-on', S.snackAddon.label + ' &mdash; &#8369;' + S.snackAddon.price.toLocaleString());
            }
        } else if (S.offsiteCategory === 'catering') {
            pkgRows += sr('Service', '&#127869;&#65039; Catering');
            pkgRows += sr('Inclusions', 'Buffet setup, utensils, waiters, styled tables, backdrop, centerpiece, 3-4 hrs');
            pkgRows += sr('Special Offer', 'FREE Overflowing Coffee & 1 Appetizer/Dessert');
            S.cateringCart.forEach(i => {
                total += i.price;
                pkgRows += sr(i.cat + ' (' + i.pax + ' pax)', i.dish + ' &mdash; &#8369;' + i.price.toLocaleString());
            });
            if (total === 0) pkgRows += sr('Price', 'Contact for quote');
        } else if (S.offsitePackage) {
            const catObj = OFFSITE_CATS.find(c => c.val === S.offsiteCategory);
            const catLabel = catObj ? catObj.label : '';
            total = S.offsitePackage.price;
            pkgRows += sr('Service', catLabel);
            pkgRows += sr('Package', S.offsitePackage.label);
            if (S.offsitePackage.price > 0) pkgRows += sr('Price', '&#8369;' + S.offsitePackage.price.toLocaleString());
        }

        const totalStr = total > 0 ? '&#8369;' + total.toLocaleString() : 'Contact for quote';
        const locStr   = S.locationType === 'onsite'
            ? '&#127968; Onsite &mdash; ELI Coffee'
            : '&#128663; Offsite &mdash; ' + S.venueLocation;

        box.innerHTML =
            '<div class="summary-section-title">Event</div>' +
            sr('Event Type', S.eventType) +
            sr('Date', S.eventDate) +
            sr('Time', S.time) +
            sr('Guests', S.guestCount) +
            sr('Location', locStr) +
            '<hr class="summary-divider">' +
            '<div class="summary-section-title">Package</div>' +
            pkgRows +
            '<hr class="summary-divider">' +
            '<div class="summary-section-title">Contact</div>' +
            sr('Name', S.name) +
            sr('Email', S.email) +
            sr('Phone', S.phone) +
            (S.requests ? sr('Requests', S.requests) : '') +
            '<hr class="summary-divider">' +
            '<div class="summary-total"><span>Total</span><span>' + totalStr + '</span></div>';

        document.getElementById('guest-warning').classList.toggle('hidden', isLoggedIn);
    }

    function sr(label, value) {
        return '<div class="summary-row"><span class="s-label">' + label + '</span><span class="s-value">' + value + '</span></div>';
    }

    function validate(n) {
        const id = sid(n);

        if (id === 'rs1') {
            const et = document.getElementById('event-type').value.trim();
            const gc = document.getElementById('guest-count').value.trim();
            const ed = document.getElementById('event-date').value;
            if (!et || !gc || !ed) { alert('Please fill in all event details.'); return false; }
            const d = new Date(ed), today = new Date(); today.setHours(0,0,0,0);
            if (d < today) { alert('Please select a future date.'); return false; }
            S.eventType = et; S.guestCount = gc; S.eventDate = ed;
        }

        if (id === 'rs2') {
            if (!S.locationType) { alert('Please select Onsite or Offsite.'); return false; }
            if (S.locationType === 'offsite') {
                const v = document.getElementById('venue-location').value.trim();
                if (!v) { alert('Please enter your venue location.'); return false; }
                S.venueLocation = v;
            }
        }

        if (id === 'rs3') {
            if (S.locationType === 'onsite') {
                if (!S.miniPackage) { alert('Please select a gathering package.'); return false; }
            } else {
                if (!S.offsiteCategory) { alert('Please select a service category.'); return false; }
                if (S.offsiteCategory === 'catering') {
                    if (!isCateringSelectionValid()) {
                        alert('Please select at least 1 main dish, 1 pasta, and 1 dessert for your catering package.');
                        return false;
                    }
                } else {
                    if (!S.offsitePackage) { alert('Please select a specific package.'); return false; }
                }
            }
        }

        // rs5 = Time Slot (now step 4 in the flow)
        if (id === 'rs5') {
            if (!S.time) { alert('Please select a time slot.'); return false; }
        }

        // rs4 = Your Details (now step 5 in the flow)
        if (id === 'rs4') {
            const name  = document.getElementById('name').value.trim();
            const phone = document.getElementById('phone').value.trim();
            const email = document.getElementById('email').value.trim();
            if (!name || !phone || !email) { alert('Please fill in all contact details.'); return false; }
            if (!/^\S+@\S+\.\S+$/.test(email)) { alert('Please enter a valid email.'); return false; }
            S.name = name; S.phone = phone; S.email = email;
            S.requests = document.getElementById('requests').value.trim();
        }

        if (id === 'rs6') {
            if (!isLoggedIn) {
                document.getElementById('guest-warning').classList.remove('hidden');
                return false;
            }
        }

        if (id === 'rs7') {
            if (!document.getElementById('contract').files.length) {
                alert('Please upload your signed contract.'); return false;
            }
        }

        return true;
    }

    document.getElementById('nextBtn').onclick = () => {
        if (!validate(cur)) return;
        if (cur < total()) { cur++; showStep(cur); }
        else { submitDone(); }
    };

    document.getElementById('prevBtn').onclick = () => {
        if (cur > 1) { cur--; showStep(cur); }
    };

    document.querySelectorAll('.location-card').forEach(c => {
        c.onclick = () => {
            document.querySelectorAll('.location-card').forEach(x => x.classList.remove('active'));
            c.classList.add('active');
            S.locationType    = c.dataset.val;
            S.miniPackage     = null;
            S.snackAddon      = null;
            S.offsiteCategory = '';
            S.offsitePackage  = null;
            S.cateringCart    = [];
            document.getElementById('venue-wrapper').classList.toggle('hidden', S.locationType !== 'offsite');
        };
    });

    async function submitDone() {
        const nextBtn = document.getElementById('nextBtn');
        nextBtn.disabled = true;
        nextBtn.textContent = 'Submitting...';

        try {
            const { data: { session } } = await supabase.auth.getSession();
            const userId = session.user.id;

            const contractFile = document.getElementById('contract').files[0];
            const formData = new FormData();
            formData.append('file',          contractFile);
            formData.append('upload_preset', 'eli_contracts');
            formData.append('folder',        'contracts');

            const cloudName = 'dtt707f1w';
            const cloudRes  = await fetch(
                'https://api.cloudinary.com/v1_1/' + cloudName + '/auto/upload',
                { method: 'POST', body: formData }
            );
            if (!cloudRes.ok) throw new Error('Contract upload failed. Please try again.');
            const cloudData   = await cloudRes.json();
            const contractUrl = cloudData.secure_url;

            let packageId  = null;
            let addOnId    = null;
            let totalPrice = 0;

            if (S.locationType === 'onsite') {
                packageId  = S.miniPackage ? S.miniPackage.id : null;
                addOnId    = S.snackAddon  ? S.snackAddon.id  : null;
                totalPrice = (S.miniPackage ? S.miniPackage.price : 0)
                           + (S.snackAddon  ? S.snackAddon.price  : 0);
            } else if (S.offsiteCategory === 'catering') {
                // Catering package row in the package table
                const cateringPkg = OFFSITE_PKGS.catering[0];
                packageId  = cateringPkg ? cateringPkg.id : null;
                totalPrice = S.cateringCart.reduce((sum, i) => sum + i.price, 0);
            } else {
                packageId  = S.offsitePackage ? S.offsitePackage.id    : null;
                totalPrice = S.offsitePackage ? S.offsitePackage.price : 0;
            }

            const { data: reservation, error: insertError } = await supabase
                .from('reservations')
                .insert({
                    user_id:          userId,
                    event_type:       S.eventType,
                    event_date:       S.eventDate,
                    event_time:       S.time,
                    guest_count:      parseInt(S.guestCount),
                    location_type:    S.locationType,
                    venue_location:   S.venueLocation || null,
                    package_id:       packageId,
                    add_on_id:        addOnId,
                    total_price:      totalPrice,
                    contact_name:     S.name,
                    contact_email:    S.email,
                    contact_phone:    S.phone,
                    special_requests: S.requests || null,
                    status:           'pending'
                })
                .select('reservation_id')
                .single();

            if (insertError) throw new Error('Reservation save failed: ' + insertError.message);

            const selectedContract = getSelectedContractInfo();
            const { error: contractInsertError } = await supabase
                .from('contracts')
                .insert({
                    reservation_id: reservation.reservation_id,
                    contract_type: selectedContract?.contractType || 'package_contract',
                    description: selectedContract
                        ? 'Signed contract upload for ' + selectedContract.title
                        : 'Signed reservation contract upload',
                    contract_url: contractUrl,
                    verified_date: null
                });

            if (contractInsertError) {
                throw new Error('Contract save failed: ' + contractInsertError.message);
            }

            document.querySelectorAll('.res-step').forEach(s => s.classList.remove('active'));
            document.querySelector('.reservation-buttons').style.display = 'none';
            document.querySelector('.progress-container').style.display  = 'none';

            const msg = document.createElement('div');
            msg.className = 'summary-box';
            msg.style.cssText = 'text-align:center;padding:48px 20px;';
            msg.innerHTML =
                '<div style="font-size:52px;margin-bottom:16px;">&#9989;</div>' +
                '<h3 style="color:#2A1408;font-size:22px;margin-bottom:10px;font-weight:700;">Reservation Submitted!</h3>' +
                '<p style="color:#777;line-height:1.8;font-size:15px;">' +
                'Thank you, <strong>' + S.name + '</strong>!<br>' +
                'Your reservation is <strong style="color:#6B3A1F;">under verification</strong>.<br>' +
                'We\'ll contact you at <strong>' + S.email + '</strong> to confirm.' +
                '</p>';
            document.querySelector('.reservation-container').appendChild(msg);

        } catch (err) {
            alert(err.message);
            nextBtn.disabled = false;
            nextBtn.textContent = 'Submit';
        }
    }

    function card(html, isActive) {
        const d = document.createElement('div');
        d.className = 'pkg-card' + (isActive ? ' active' : '');
        d.innerHTML = html;
        return d;
    }

    function pill(text, isActive) {
        const d = document.createElement('div');
        d.className = 'pill' + (isActive ? ' active' : '');
        d.textContent = text;
        return d;
    }

    function activate(container, el) {
        container.querySelectorAll('.pkg-card').forEach(c => c.classList.remove('active'));
        el.classList.add('active');
    }

    function activatePill(container, el) {
        container.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
        el.classList.add('active');
    }

    // Load packages from DB first, then start the form
    await loadPackages();
    showStep(1);
    