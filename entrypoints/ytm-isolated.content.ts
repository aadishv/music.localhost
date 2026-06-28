export default defineContentScript({
    matches: ["*://music.youtube.com/*"],
    runAt: "document_start",
    main() {
        console.log("[YTM-Isolated] Content script loaded");

        window.addEventListener("message", (event) => {
            if (!event.data || event.data.source !== "ytm-main") return;

            if (
                event.data.type === "METADATA_UPDATE" ||
                event.data.type === "PLAYER_STATE_UPDATE"
            ) {
                console.log(event.data);
                browser.runtime
                    .sendMessage({
                        type: event.data.type,
                        payload: event.data.payload,
                    })
                    .catch(() => {
                        // Ignore error when background page is temporarily inactive/disconnected
                    });
            }
        });

        browser.runtime.onMessage.addListener((message) => {
            console.log(message);
            if (message.type === "COMMAND" || message.type === "SEEK") {
                window.postMessage(
                    {
                        source: "ytm-isolated",
                        type: message.type,
                        payload: message,
                    },
                    "*",
                );
            }
        });
    },
});
