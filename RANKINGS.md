# Bảng Fanqie trong newtomato

Bridge: `0.0.7-wiki-4.2.7`. Giữ tên, namespace, attribution và giấy phép GPLv3 của Fanqie Assistant.

## Bảng trên ứng dụng

Danh sách 19 mã dưới đây lấy từ `main_algo_type` và `sub_algo_type` trong đường dẫn landing chính thức. Tên đã dịch bằng Dịch Ngay ngày 06/10/2026, rồi chỉnh cách diễn đạt cho giao diện tiếng Việt.

| Mã | Tên trên giao diện |
| --- | --- |
| 100 | Bảng hoàn thành |
| 101 | Bảng đề cử |
| 102 | Bảng ngựa ô |
| 103 | Bảng tìm kiếm nổi bật |
| 104 | Bảng danh tiếng |
| 108 | Bảng truyện mới |
| 109 | Bảng theo dõi chương mới |
| 110 | Bảng bình luận nổi bật |
| 111 | Bảng đọc |
| 115 | Bảng điểm cao |
| 116 | Bảng hoàn thành theo thể loại |
| 135 | Bảng đề cử theo thể loại |
| 146 | Bảng nhân khí |
| 188 | Bảng quà tặng |
| 196 | Bảng xuất bản kinh điển |
| 197 | Bảng xuất bản tăng trưởng |
| 200 | Bảng đỉnh cao |
| 201 | Bảng phát sóng nổi bật |
| 205 | Bảng tác giả |

APP gọi `/reading/bookapi/bookmall/cell/change/v1/` bằng chữ ký sẵn có. Bridge lấy đường dẫn `common-rank-list` từ `/reading/bookapi/plan/v`, giải mã các lớp URL và ghép tham số của đường dẫn vào request; giữ `cell_id` dạng chuỗi. Chỉ gửi riêng `algo_type` từng gây `PARAM_INVALID`.

Phản hồi người dùng cung cấp đã xác nhận bảng đỉnh cao mã 200, nhóm tháng gồm 30 truyện. Người dùng sau đó xác nhận cả bảy bảng ban đầu chạy thành công (200, 101, 100, 109, 102, 111, 108). Các mã bổ sung được lấy từ cấu hình chính thức nhưng chưa được thử trực tiếp trong phiên của người dùng.

Giới tính APP: nữ tần 0, nam tần 1, toàn bộ 2; truyền qua `gender_list_type`. Bảng đỉnh cao mặc định chọn nhóm tương ứng: tháng 1, nam tần 5, nữ tần 4. Có thể chọn nhóm riêng. Kỳ xếp hạng gửi `daily`, `weekly`, `monthly`; mã 104 có trong cấu hình `monthly_algo_type`. API có thể không hỗ trợ mọi cặp bảng/giới tính/kỳ.

Bảng tác giả đọc metadata tác giả, bảng phát sóng đọc `video_data`. Những mục này được hiển thị riêng và không được đưa vào read.json hay coi là ID truyện. Tên bảng và bộ lọc hiển thị tiếng Việt; tên tác phẩm, tác giả và từ khóa vẫn là dữ liệu gốc.

## Cách dùng

1. Cài userscript bridge 4.2.7 và tải lại tab Fanqie.
2. Mở tab Bảng Fanqie, bấm Kết nối tab Fanqie.
3. Chọn mã bảng, giới tính, kỳ xếp hạng và bấm Lấy danh sách mới.
4. Tải tiếp sử dụng offset và session_id của phản hồi. Chỉ truyện có chức năng Copy ID và đánh dấu đã đọc.

Danh sách website và landing vẫn có trong nhóm riêng. Bảng đọc/truyện mới trên website dùng mã danh mục của website và chỉ hỗ trợ nam/nữ tần. Snapshot website vẫn có thể xem khi chưa kết nối.

Lỗi API, bảng trả sai mã hoặc nhóm rỗng giữ dữ liệu cũ. Phản hồi bridge phải đúng origin, worker và ID request. Request cũ không ghi đè lựa chọn mới. Những bảng chưa được API hỗ trợ không được thay bằng bảng khác.

## Kiểm tra

Chạy tại thư mục repo:

```sh
node tests/test_rankings.cjs
node tests/test_app_rankings.cjs
node tests/test_ranking_ui.cjs
```

Kiểm tra APP dùng phản hồi giả lập để kiểm tra tham số, giới tính, 19 mã, nhóm tháng, metadata, bảng tác giả/phát sóng và lỗi. Đây không phải bằng chứng 19 bảng đều trả dữ liệu trực tiếp.

## Nguồn

- Fanqie Assistant đính kèm, bản 0.0.6.2; bridge nền 4.2 của người dùng.
- Phản hồi landing và APP do người dùng cung cấp ngày 06/10/2026.
- Template chính thức: https://lf-normal-gr-sourcecdn.bytegecko.com/obj/byte-gurd-source-gr/novel/dr/fe/drlynx_distribution/common-rank-list/template.js
- Dịch tên tham số: https://dichngay.com/

## Tải bù sau lọc

Mỗi trang bảng xếp hạng hiển thị tối đa 30 card, độc lập với giới hạn trang của các tab khác. Trước mỗi lượt lấy/lấy tiếp, tải lại read.json và cleanup_abstract_keywords.json từ nhánh data. Từ khóa khớp cụm liên tiếp, phân biệt hoa/thường, chỉ trên tóm tắt như cleanup-books.js; không đổi sang khớp tên hay tag.

Nếu thiếu tóm tắt hoặc gặp font PUA, bridge thử metadata APP với tối đa ba request song song. Truyện chưa xác minh tóm tắt tạm không hiện khi có từ khóa dọn dẹp; không tự thêm các trường hợp thiếu metadata vào read.json.

Tải các trang tuần tự theo next_offset và session_id/rank_version do API trả về đến khi đủ card sau lọc. Giữ truyện dư để dùng cho trang sau. Không đoán offset ngẫu nhiên khi API báo hết. Landing và bảng cố định có thể không đủ 30 sau lọc. Bảng tác giả/phát sóng không áp dụng ID truyện/tóm tắt truyện, nhưng vẫn dùng trang 30 mục.

Khi đánh dấu đã đọc hoặc luật read tự động ẩn card, render sẽ bù trang hiện tại nếu còn nguồn. Lỗi giữ các trang đã tải và offset để thử lại. Dừng nếu dữ liệu trang lặp, offset không tiến, trang rỗng hoặc has_more=false. Mỗi lượt tối đa 40 trang; có thể bấm tải tiếp để tiếp tục nếu sau lọc vẫn thiếu.

Kiểm tra bổ sung: node tests/test_ranking_fill.cjs. Kiểm tra dùng API giả lập; không chứng minh mọi bảng Fanqie có nguồn hơn 30 truyện.
