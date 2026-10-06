# Bảng Fanqie trong newtomato

## Cách dùng

1. Mở tab **Bảng Fanqie**, bấm **Kết nối tab Fanqie** và giữ tab Fanqie mở.
2. Chọn bảng, giới tính và kỳ xếp hạng rồi bấm **Lấy danh sách mới**.
3. Bấm **Tải thêm 30 card sau lọc** để xem tiếp khi nguồn còn dữ liệu.

Có 19 bảng ứng dụng và một nhóm bảng trên website. Bảng tác giả/phát sóng hiển thị nội dung riêng; chỉ danh sách truyện hỗ trợ đánh dấu đã đọc và Copy ID.

## Lọc và phân trang

Mỗi trang hiển thị tối đa 30 card, độc lập với giới hạn trang của các tab khác. Trước mỗi lượt lấy/lấy tiếp, đọc lại `data/read.json` và `data/cleanup_abstract_keywords.json` trên nhánh dữ liệu.

Từ khóa dọn dẹp khớp cụm liên tiếp trong tóm tắt, phân biệt hoa/thường, như `cleanup-books.js`. Truyện thiếu tóm tắt đã xác minh tạm không hiển thị khi có bộ lọc từ khóa.

Ứng dụng tải tiếp theo phân trang của nguồn đến khi đủ card sau lọc. Truyện dư được giữ cho trang sau. Đánh dấu đã đọc sẽ ẩn card và bù trang hiện tại nếu còn nguồn.

Nguồn cố định hoặc đã hết dữ liệu có thể còn dưới 30 card. Lỗi giữ dữ liệu đã tải để thử lại. Dừng khi nguồn lặp trang, offset không tiến hoặc hết dữ liệu. Mỗi lượt tối đa 40 trang; có thể bấm tải tiếp nếu nguồn còn dữ liệu.

## Kiểm tra

Chạy tại thư mục repo:

```sh
node tests/test_rankings.cjs
node tests/test_ranking_ui.cjs
node tests/test_ranking_fill.cjs
```

Các kiểm tra giao diện sử dụng phản hồi giả lập để kiểm tra lọc, phân trang, cập nhật đã đọc, lỗi, và kết quả cũ. Chúng không chứng minh mọi kết hợp bảng/giới tính/kỳ đều được Fanqie hỗ trợ.
