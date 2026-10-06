# Bảng Fanqie trong newtomato

Kiểm tra ngày 06/10/2026. Bridge mới: `0.0.7-wiki-4.2.1`, dựa trên bản `4.2` của người dùng; giữ nguyên tên/namespace để Tampermonkey cập nhật cùng script. Mã gốc Fanqie Assistant giữ giấy phép GPLv3 và attribution trong userscript.

| Loại | Kết quả |
| --- | --- |
| 巅峰榜 | API chính thức `/api/author/misc/top_book_list/v1/` trả 30 truyện. Đã lưu snapshot và hỗ trợ lấy mới. Không giả định API có phân trang. |
| 官网推荐 | `/api/rank/recommend/list?type=3` trả đề cử nữ tần trên website. Đây không phải bằng chứng cho 推荐榜 trong APP. |
| 阅读榜 | `/api/rank/category/list`, `rankMold=2`, chọn giới tính và danh mục. Đã xác minh có dữ liệu. |
| 新书榜 | Cùng API, `rankMold=1`. JavaScript chính thức hiện tại ghi `read:2,new:1`; không phải hoàn thành. |
| 热搜 / 巅峰榜 / 漫画榜 trên trang tìm kiếm | `/reading/bookapi/plan/v` với `scene=10`, lấy bằng hàm ký `webGet` và `getSearchLanding` sẵn có trong bridge. Mục nào Fanqie trả về sẽ hiện đúng tên đó. Đây là các mục rút gọn, không mặc định là bảng đầy đủ. |
| 推荐榜 APP / 完本榜 / 追更榜 / 黑马榜 | Chưa xác minh endpoint và dữ liệu đúng loại. UI ghi rõ chưa hỗ trợ. Không đoán mã số, không lọc truyện hoàn thành từ bảng khác rồi gọi là 完本榜. |

## Cách dùng

1. Cài/cập nhật `userscripts/fanqie-wiki-bridge.user.js` thay bản v4.2 trong Tampermonkey.
2. Mở tab **Bảng Fanqie** trên newtomato. Snapshot 巅峰榜 và đề cử có thể xem ngay.
3. Bấm **Kết nối tab Fanqie**. Cho phép popup khi trình duyệt yêu cầu. Giữ tab này mở; đây là nơi ký và thực hiện request.
4. Chọn bảng, giới tính/danh mục khi có, rồi bấm **Lấy danh sách mới**. **Tải tiếp** dùng offset/rankVersion do API trả về.
5. Các mục trên trang tìm kiếm có nút chọn riêng; từ khóa mở tìm kiếm Fanqie trong tab mới. Card dùng renderer, score, trạng thái và read.json hiện có. Copy ID lấy danh sách đã tải, bỏ truyện đã đọc và áp dụng bộ lọc trạng thái.

Request thất bại giữ danh sách đã tải. Thay lựa chọn trong lúc request đang chạy không cho kết quả cũ ghi vào bảng mới. Các phản hồi bridge phải khớp origin Fanqie, tab worker và ID request.

Tên/abstract của API bảng theo danh mục có font riêng (ký tự PUA). Bridge lấy metadata chữ thật qua `/reading/bookapi/multi-detail/v` đã dùng trong v4.2, tối đa ba request song song. Nếu metadata lỗi, UI hiện □ và số mục lỗi; không giả vờ tên đã được giải mã.

## Nguồn xác minh

- Script đính kèm `fanqie-assistant v0.0.6.2.user.js`: `getSearchLanding`, `/bookapi/plan/v`, cách đọc `cell_data/search_tag_data/book_data`.
- [Website bảng Fanqie](https://fanqienovel.com/rank/5): danh mục từ `window.__INITIAL_STATE__.rank.rankCategoryTypeList` và hướng dẫn bảng đọc/truyện mới.
- [JavaScript chính thức](https://lf-fe.fqnovelstatic.com/obj/novel-fanqie-fe/toutiao/muye/js/muye_5f7ec5dd.js): API bảng và `read:2,new:1`.
- [API đỉnh cao](https://fanqienovel.com/api/author/misc/top_book_list/v1/) và API đề cử: đã gọi trực tiếp để tạo snapshot trong commit này.

Phạm vi kiểm tra: gọi trực tiếp API web; kiểm tra cú pháp và regression tests, mock bridge/metadata/UI. Chưa chạy userscript có chữ ký trong trình duyệt của người dùng, nên danh sách thực tế của trang tìm kiếm cần kiểm tra sau khi cài. Không thêm workflow tự động hay lịch scrape mới.
