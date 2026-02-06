const cheerio = require('cheerio');
const Telenode = require('telenode-js');
const fs = require('fs');
const config = require('./config.json');

const extractJsonData = ($) => {
    const scriptContent = $("#__NEXT_DATA__").html();
    if (!scriptContent) {
        throw new Error("Could not find __NEXT_DATA__ script");
    }
    try {
        return JSON.parse(scriptContent);
    } catch (e) {
        console.error("Failed to parse JSON", e);
        throw new Error("Failed to parse __NEXT_DATA__ JSON");
    }
}

const scrapeItems = async (url) => {
    const getYad2Response = async (url) => {
        const requestOptions = {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            redirect: 'follow'
        };
        try {
            const res = await fetch(url, requestOptions)
            return await res.text()
        } catch (err) {
            console.log(err)
        }
    }

    const yad2Html = await getYad2Response(url);
    if (!yad2Html) {
        throw new Error("Could not get Yad2 response");
    }

    const $ = cheerio.load(yad2Html);
    const title = $("title").first().text();
    if (title === "ShieldSquare Captcha") {
        throw new Error("Bot detection");
    }

    let feedItems = [];
    try {
        const jsonData = extractJsonData($);

        if (jsonData?.props?.pageProps) {
            if (jsonData.props.pageProps.dehydratedState) {
                const queries = jsonData.props.pageProps.dehydratedState.queries || [];
                const feedQuery = queries.find(q => Array.isArray(q.queryKey) && q.queryKey.includes('feed'));

                if (feedQuery && feedQuery.state?.data) {
                    const data = feedQuery.state.data;
                    const commercialItems = data.commercial || [];
                    const privateItems = data.private || [];
                    feedItems = [...commercialItems, ...privateItems];
                }
            } else if (jsonData.props.pageProps.search) {
                // Fallback for older structure if it appears
                feedItems = jsonData.props.pageProps.search.results.feed.data || [];
            }
        }
    } catch (e) {
        console.log("JSON parse failed", e);
        throw e;
    }

    const relevantItems = feedItems.filter(item => item.type !== "ad");

    return relevantItems.map(item => {
        return {
            id: item.token || item.id,
            link: `https://www.yad2.co.il/item/${item.token}`,
            img_url: item.metaData?.coverImage || item.images?.[0] || null,
            price: item.price,
            year: item.vehicleDates?.yearOfProduction || item.year,
            hand: item.hand?.text || item.hand,
            km: item.km,
            merchant: item.merchant || (item.customer?.agencyName ? true : false),
            agency_name: item.customer?.agencyName || null,
            model: item.model?.text,
            sub_model: item.subModel?.text,
            city: item.address?.city?.text || null,
            area: item.address?.area?.text || null
        };
    });
}

const checkIfHasNewItem = async (currentItems, topic) => {
    const filePath = `./data/${topic}.json`;
    let savedItems = [];
    try {
        savedItems = require(filePath);
    } catch (e) {
        if (e.code === "MODULE_NOT_FOUND") {
            if (!fs.existsSync('data')) fs.mkdirSync('data');
            fs.writeFileSync(filePath, '[]');
        } else {
            console.log(e);
            throw new Error(`Could not read / create ${filePath}`);
        }
    }

    const savedIds = new Set(savedItems.map(i => i.id));
    const newItems = [];
    const allItemsToSave = [...savedItems];

    currentItems.forEach(item => {
        if (!savedIds.has(item.id)) {
            newItems.push(item);
            allItemsToSave.push(item);
        }
    });

    if (newItems.length > 0) {
        const updatedContent = JSON.stringify(allItemsToSave, null, 2);
        fs.writeFileSync(filePath, updatedContent);
        await createPushFlagForWorkflow();
    }
    return newItems;
}

const createPushFlagForWorkflow = () => {
    fs.writeFileSync("push_me", "")
}

const sendTelegramPhoto = async (photoUrl, caption, chatId, apiToken) => {
    const url = `https://api.telegram.org/bot${apiToken}/sendPhoto`;
    await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            chat_id: chatId,
            photo: photoUrl,
            caption: caption,
            parse_mode: 'Markdown'
        })
    });
}

const scrape = async (topic, url) => {
    const apiToken = process.env.API_TOKEN || config.telegramApiToken;
    const chatId = process.env.CHAT_ID || config.chatId;
    const telenode = new Telenode({ apiToken })

    try {
        await telenode.sendTextMessage(`Starting scanning ${topic}...`, chatId)
        const items = await scrapeItems(url);
        const newItems = await checkIfHasNewItem(items, topic);

        if (newItems.length > 0) {
            await telenode.sendTextMessage(`Found ${newItems.length} new items!`, chatId);

            for (const item of newItems) {
                const merchantText = item.merchant ? `🏢 סוחר (${item.agency_name || 'לא צוין'})` : `👤 פרטי`;
                const priceText = item.price ? `₪${item.price.toLocaleString()}` : 'לא צוין';

                const caption = `
🚗 **${item.model || ''} ${item.sub_model || ''}**

📍 **מיקום:** ${item.city || item.area || 'לא צוין'}
💰 **מחיר:** ${priceText}
📅 **שנה:** ${item.year || 'לא צוין'}
✋ **יד:** ${item.hand || 'לא צוין'}
📟 **קילומטר:** ${item.km ? item.km.toLocaleString() : 'לא צוין'}
${merchantText}

[לצפייה במודעה](${item.link})
`;
                if (item.img_url) {
                    try {
                        await sendTelegramPhoto(item.img_url, caption, chatId, apiToken);
                    } catch (err) {
                        console.error("Failed to send photo, sending text instead", err);
                        await telenode.sendTextMessage(caption, chatId, { parse_mode: 'Markdown' });
                    }
                } else {
                    await telenode.sendTextMessage(caption, chatId, { parse_mode: 'Markdown' });
                }
            }
        } else {
            await telenode.sendTextMessage("No new items were added", chatId);
        }
    } catch (e) {
        let errMsg = e?.message || "";
        console.error(e);
        if (errMsg) {
            errMsg = `Error: ${errMsg}`
        }
        await telenode.sendTextMessage(`Scan workflow failed... 😥\n${errMsg}`, chatId)
        throw new Error(e)
    }
}

const program = async () => {
    await Promise.all(config.projects.filter(project => {
        if (project.disabled) {
            console.log(`Topic "${project.topic}" is disabled. Skipping.`);
        }
        return !project.disabled;
    }).map(async project => {
        await scrape(project.topic, project.url)
    }))
};

program();
