
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
const UPSTREAM = "https://dev.trungsoncare.com/index.php";

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // API proxy
    if (url.pathname === "/api/product") {
        const sku = url.searchParams.get("sku");

        if (!sku || !/^\d+$/.test(sku)) {
            res.writeHead(400, {
                "Content-Type": "application/json; charset=utf-8"
            });
            return res.end(JSON.stringify({
                error: "SKU không hợp lệ"
            }));
        }

        try {
            console.log("Fetching SKU:", sku);

            const apiUrl = new URL(UPSTREAM);
            apiUrl.searchParams.set("dispatch", "miniapp.product");
            apiUrl.searchParams.set("sku", sku);

            const response = await fetch(apiUrl, {
                headers: {
                    "Accept": "application/json, text/html, */*"
                },
                signal: AbortSignal.timeout(30000)
            });

            const data = await response.text();

            res.writeHead(response.status, {
                "Content-Type":
                    response.headers.get("content-type") ||
                    "application/json; charset=utf-8"
            });

            return res.end(data);

        } catch (error) {
            console.error(error);

            res.writeHead(502, {
                "Content-Type": "application/json; charset=utf-8"
            });

            return res.end(JSON.stringify({
                error: error.message
            }));
        }
    }

    // Serve HTML
    if (url.pathname === "/" || url.pathname === "/product.html") {
        const file = path.join(__dirname, "product.html");

        fs.readFile(file, (err, content) => {
            if (err) {
                res.writeHead(500);
                return res.end("Cannot load product.html");
            }

            res.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8"
            });

            res.end(content);
        });

        return;
    }

    res.writeHead(404);
    res.end("Not Found");
});

server.listen(PORT, "127.0.0.1", () => {
    console.log("--------------------------------");
    console.log("TRUNG SON PRODUCT VIEWER");
    console.log(`http://localhost:${PORT}`);
    console.log("--------------------------------");
});
